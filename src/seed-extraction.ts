/**
 * Seed Extraction — Extract structured knowledge from documents and URLs.
 *
 * Pipeline: source → content extraction → chunking → fast LLM (gpt-4o-mini) → facts + entities
 * Integrates with Mem0 (saves facts) and GraphRAG (saves entities/relationships).
 * Supports: URL, PDF, DOCX, TXT/MD, raw text.
 */

import path from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { runFastLlmJson, runHaikuFast } from './llm-client.js';
import { addMemoryWithConflictCheck } from './mem0.js';
import { scoreActionability, scoreFactQuality } from './memory-patterns.js';
import { isGraphEnabled, ingestExtracted } from './graphrag.js';
import { SEEDS_DIR } from './workspace.js';
import { safeWriteFileSync } from './file-io-lock.js';
const ENABLED = process.env.LAIN_SEED_ENABLED !== 'false';
const MAX_CHUNKS = parseInt(process.env.LAIN_SEED_MAX_CHUNKS || '10', 10);
const MAX_FACTS = parseInt(process.env.LAIN_SEED_MAX_FACTS || '10', 10);

// ─── Boilerplate Filter (Patch 1) ───
// scoreFactQuality lives in ./memory-patterns.js (shared with media scoring).

const MIN_FACT_QUALITY_SCORE = 3;

/**
 * Filter facts: remove boilerplate, keep only quality facts.
 * Returns [kept, discarded] tuple for logging.
 */
function filterFacts(facts: string[]): [string[], string[]] {
  const kept: string[] = [];
  const discarded: string[] = [];

  for (const fact of facts) {
    const score = scoreFactQuality(fact);
    if (score >= MIN_FACT_QUALITY_SCORE) {
      kept.push(fact);
    } else {
      discarded.push(fact);
    }
  }

  return [kept, discarded];
}

// ─── Types ───

export interface SeedInput {
  type: 'url' | 'pdf' | 'docx' | 'txt' | 'text';
  source: string;
  rawText?: string;
  project?: string;
  phone?: string;
  /** Language hint for extraction (e.g. 'pt-br', 'en'). Auto-detected from project context if omitted. */
  language?: string;
  /** Force re-extraction even if source was already extracted. Bypasses source dedup check. */
  force?: boolean;
}

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

interface ExtractedRelationship {
  subject: string;
  predicate: string;
  object: string;
}

export interface SeedOutput {
  id: string;
  source: string;
  type: string;
  title: string;
  summary: string;
  facts: string[];
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  chunks: number;
  wordCount: number;
  processedAt: number;
  project?: string;
  memoryIds: string[];
}

const SeedOutputSchema: z.ZodType<SeedOutput> = z.object({
  id: z.string(),
  source: z.string(),
  type: z.string(),
  title: z.string(),
  summary: z.string(),
  facts: z.array(z.string()),
  entities: z.array(z.object({ name: z.string(), type: z.string(), description: z.string() })),
  relationships: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() })),
  chunks: z.number(),
  wordCount: z.number(),
  processedAt: z.number(),
  project: z.string().optional(),
  memoryIds: z.array(z.string()),
});

function parseSeedFile(raw: string): SeedOutput | null {
  try {
    return SeedOutputSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Auto-detect language from project name. Brazilian projects default to PT-BR. */
function detectLanguage(project?: string): string | undefined {
  if (!project) return undefined;
  const name = project.toLowerCase();
  // Known Brazilian projects
  const brProjects = ['reino', 'kapso', 'lain', 'call-me', 'relatorio', 'dashboard', 'crm'];
  if (brProjects.some(p => name.includes(p))) return 'pt-br';
  return undefined;
}

function detectType(source: string): SeedInput['type'] {
  if (source.startsWith('http://') || source.startsWith('https://')) return 'url';
  const ext = path.extname(source).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt' || ext === '.md') return 'txt';
  return 'text';
}

// ─── Content Extractors ───

async function extractFromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const html = await response.text();
  const { NodeHtmlMarkdown } = await import('node-html-markdown');
  return NodeHtmlMarkdown.translate(html);
}

async function extractFromPdf(filePath: string): Promise<string> {
  const { readPdf } = await import('./pdf-reader/index.js');
  const result = await readPdf({ filePath });
  return result.text;
}

async function extractFromDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function extractFromTxt(filePath: string): Promise<string> {
  return readFileSync(filePath, 'utf-8');
}

async function extractContent(input: SeedInput): Promise<string> {
  switch (input.type) {
    case 'url': return extractFromUrl(input.source);
    case 'pdf': return extractFromPdf(input.source);
    case 'docx': return extractFromDocx(input.source);
    case 'txt': return extractFromTxt(input.source);
    case 'text': return input.rawText || '';
    default: throw new Error(`Unsupported type: ${input.type}`);
  }
}

// ─── Chunking ───

function chunkText(text: string, maxTokens: number = 2000): string[] {
  const maxChars = maxTokens * 4;
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      for (const sent of sentences) {
        if ((current + sent).length > maxChars && current.length > 0) {
          chunks.push(current.trim());
          current = '';
        }
        current += sent + ' ';
      }
      continue;
    }
    if ((current + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ─── LLM Processing ───

function buildExtractionPrompt(language?: string): string {
  const langInstruction = language === 'pt-br'
    ? `\nIMPORTANT: Extract ALL facts, summaries, and entity descriptions in Brazilian Portuguese (PT-BR).
Entity names should use their PT-BR form when a well-known translation exists (e.g. "portfolio de investimentos" not "investment portfolio").
Do NOT extract legal disclaimers, copyright notices, or generic methodology descriptions as facts.`
    : language === 'en'
    ? `\nIMPORTANT: Extract all content in English.
Do NOT extract legal disclaimers, copyright notices, or generic methodology descriptions as facts.`
    : `\nDo NOT extract legal disclaimers, copyright notices, or generic methodology descriptions as facts.`;

  return `Analyze this text and extract structured knowledge.
Return ONLY valid JSON:
{
  "title": "Document title or topic",
  "summary": "2-3 sentence summary",
  "facts": ["key fact 1", "key fact 2"],
  "entities": [{"name": "string", "type": "Person|Project|Technology|Company|Concept|Location|Other", "description": "string"}],
  "relationships": [{"subject": "string", "predicate": "string", "object": "string"}]
}

Predicate vocabulary: WORKS_ON, USES, OWNS, MANAGES, DEPENDS_ON, RELATED_TO, LOCATED_IN, PART_OF, CREATED, PREFERS, DESCRIBES, MENTIONS
${langInstruction}
Text:
`;
}

interface ChunkResult {
  title: string;
  summary: string;
  facts: string[];
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

async function processChunk(chunk: string, language?: string, retries = 1): Promise<ChunkResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runFastLlmJson<ChunkResult>(buildExtractionPrompt(language) + chunk);
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[seed] Chunk processing attempt ${attempt + 1} failed, retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

async function mergeChunkResults(results: ChunkResult[]): Promise<{
  title: string; summary: string; facts: string[];
  entities: ExtractedEntity[]; relationships: ExtractedRelationship[];
}> {
  const title = results[0]?.title || 'Untitled';
  const joinedSummary = results.map(r => r.summary).join(' ');

  let summary = joinedSummary;
  if (results.length > 1) {
    try {
      const condensed = await runHaikuFast(
        `Re-summarize the following multi-chunk extraction into 2-3 concise sentences. Preserve the most important facts. Output only the summary text, no preamble.\n\n${joinedSummary}`
      );
      if (condensed && condensed.trim().length > 0) {
        summary = condensed.trim();
      }
    } catch {
      // Fall back to concatenated summary so extraction is never blocked
    }
    if (process.env.LAIN_BENCH === '1') {
      console.log(JSON.stringify({
        tag: '[bench]', ts: Date.now(), file: 'seed-extraction',
        func: 'mergeChunkResults', chunks: results.length,
        joined_summary_chars: joinedSummary.length,
        final_summary_chars: summary.length,
        compression_ratio: parseFloat((summary.length / joinedSummary.length).toFixed(2)),
      }));
    }
  }

  const factsSet = new Set<string>();
  for (const r of results) for (const f of r.facts) factsSet.add(f);

  const entityMap = new Map<string, ExtractedEntity>();
  for (const r of results) {
    for (const e of r.entities) {
      const key = e.name.toLowerCase().trim();
      const existing = entityMap.get(key);
      if (!existing || e.description.length > (existing.description?.length || 0)) {
        entityMap.set(key, e);
      }
    }
  }

  const relSet = new Set<string>();
  const relationships: ExtractedRelationship[] = [];
  for (const r of results) {
    for (const rel of r.relationships) {
      const key = `${rel.subject}|${rel.predicate}|${rel.object}`;
      if (!relSet.has(key)) {
        relSet.add(key);
        relationships.push(rel);
      }
    }
  }

  return {
    title,
    summary,
    facts: Array.from(factsSet),
    entities: Array.from(entityMap.values()),
    relationships,
  };
}

// ─── Storage ───

async function storeSeedResults(output: SeedOutput, project?: string): Promise<string[]> {
  const memoryIds: string[] = [];

  try {
    const results = await addMemoryWithConflictCheck(`[Seed: ${output.title}] ${output.summary}`, project, { skipQualityCheck: true });
    if (Array.isArray(results) && results[0]?.id) memoryIds.push(results[0].id);
  } catch (err) {
    console.error('[seed] Failed to save summary:', err);
  }

  // Filter boilerplate before saving — only quality facts go to Mem0
  const [qualityFacts, discardedFacts] = filterFacts(output.facts);
  if (discardedFacts.length > 0) {
    console.log(`[seed] Filtered ${discardedFacts.length} low-quality/boilerplate facts`);
  }
  const factsToSave = qualityFacts.slice(0, MAX_FACTS);
  const BATCH_SIZE = 5;
  for (let i = 0; i < factsToSave.length; i += BATCH_SIZE) {
    const batch = factsToSave.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(fact => addMemoryWithConflictCheck(`[Seed: ${output.title}] ${fact}`, project, { skipQualityCheck: true }))
    );
    for (const res of batchResults) {
      if (res.status === 'fulfilled' && Array.isArray(res.value) && res.value[0]?.id) {
        memoryIds.push(res.value[0].id);
      } else if (res.status === 'rejected') {
        console.error(`[seed] Failed to save fact: ${res.reason}`);
      }
    }
  }

  if (isGraphEnabled()) {
    try {
      await ingestExtracted(output.entities, output.relationships);
    } catch (err) {
      console.error('[seed] GraphRAG ingestion error:', err);
    }
  }

  return memoryIds;
}

function ensureSeedsDir(): void {
  if (!existsSync(SEEDS_DIR)) mkdirSync(SEEDS_DIR, { recursive: true });
}

// ─── Public API ───

export async function extractSeed(input: SeedInput): Promise<SeedOutput> {
  if (!ENABLED) throw new Error('Seed extraction is disabled');

  if (!input.type || input.type === 'text') {
    input.type = input.source ? detectType(input.source) : 'text';
  }

  // Auto-detect language from project context (Brazilian projects default to PT-BR)
  const language = input.language || detectLanguage(input.project);
  console.log(`[seed] Extracting from ${input.type}: ${input.source} (lang: ${language || 'auto'})`);

  // Source-level dedup: return existing seed if same source was already extracted
  if (!input.force) {
    const existing = listSeeds(input.project)
      .find(s => s.source === input.source);
    if (existing) {
      console.log(`[seed] Dedup hit — source already extracted as ${existing.id}, returning existing seed`);
      return existing;
    }
  }

  const rawText = await extractContent(input);
  const wordCount = rawText.split(/\s+/).length;

  const chunks = chunkText(rawText).slice(0, MAX_CHUNKS);
  console.log(`[seed] ${wordCount} words, ${chunks.length} chunks`);

  // Process chunks in parallel (up to 5 concurrent)
  const CONCURRENCY = Math.min(5, chunks.length);
  const chunkResults: ChunkResult[] = new Array(chunks.length);
  const chunkErrors: number[] = [];

  async function processWithConcurrency() {
    let nextIdx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (nextIdx < chunks.length) {
        const idx = nextIdx++;
        try {
          chunkResults[idx] = await processChunk(chunks[idx], language);
        } catch (err) {
          console.error(`[seed] Chunk ${idx} processing failed:`, err);
          chunkErrors.push(idx);
        }
      }
    });
    await Promise.all(workers);
  }
  await processWithConcurrency();

  // Filter out failed chunks (undefined slots)
  const validResults = chunkResults.filter((r): r is ChunkResult => r != null);

  if (validResults.length === 0) {
    throw new Error('No chunks could be processed');
  }
  console.log(`[seed] ${validResults.length}/${chunks.length} chunks processed successfully`);

  const merged = await mergeChunkResults(validResults);

  const seedId = generateId();
  const output: SeedOutput = {
    id: seedId,
    source: input.source,
    type: input.type,
    title: merged.title,
    summary: merged.summary,
    facts: merged.facts,
    entities: merged.entities,
    relationships: merged.relationships,
    chunks: chunks.length,
    wordCount,
    processedAt: Date.now(),
    project: input.project,
    memoryIds: [],
  };

  output.memoryIds = await storeSeedResults(output, input.project);

  ensureSeedsDir();
  const seedPath = path.join(SEEDS_DIR, `${seedId}.json`);
  safeWriteFileSync(seedPath, JSON.stringify(output, null, 2));

  console.log(`[seed] Extracted ${merged.facts.length} facts, ${merged.entities.length} entities from "${merged.title}"`);
  return output;
}

export function listSeeds(project?: string): SeedOutput[] {
  ensureSeedsDir();
  const files = readdirSync(SEEDS_DIR).filter(f => f.endsWith('.json'));
  const seeds: SeedOutput[] = [];
  for (const file of files) {
    try {
      const seed = parseSeedFile(readFileSync(path.join(SEEDS_DIR, file), 'utf-8'));
      if (seed && (!project || seed.project === project)) {
        seeds.push(seed);
      }
    } catch {}
  }
  return seeds.sort((a, b) => b.processedAt - a.processedAt);
}

export function getSeed(id: string): SeedOutput | null {
  const seedPath = path.join(SEEDS_DIR, `${id}.json`);
  if (!existsSync(seedPath)) return null;
  return parseSeedFile(readFileSync(seedPath, 'utf-8'));
}

export async function deleteSeed(id: string): Promise<boolean> {
  const seed = getSeed(id);
  if (!seed) return false;

  if (seed.memoryIds?.length) {
    const { deleteMemory } = await import('./mem0.js');
    for (const memId of seed.memoryIds) {
      try { await deleteMemory(memId); } catch {}
    }
  }

  const seedPath = path.join(SEEDS_DIR, `${id}.json`);
  try { unlinkSync(seedPath); } catch {}
  return true;
}

/**
 * Delete an existing seed and re-extract from the same source.
 * Throws if the seed ID does not exist or cannot be loaded.
 * Always uses force:true to bypass source dedup on the fresh extraction.
 */
export async function reprocessSeed(id: string): Promise<SeedOutput> {
  const existing = getSeed(id);
  if (!existing) {
    throw new Error(`reprocessSeed: seed ${id} not found`);
  }

  const { source, type, project, language } = existing as SeedOutput & { language?: string };

  await deleteSeed(id);

  return extractSeed({ source, type: type as SeedInput['type'], project, language, force: true });
}
