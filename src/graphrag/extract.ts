/**
 * LLM extraction for graphrag (graphrag split G4).
 *
 * Entity/relationship extraction and decision auto-detection. Results are
 * cached (extractions are billed per token). No graph writes here.
 */

import { runFastLlmJson } from '../llm-client.js';
import {
  CACHE_TTL_EXTRACTION,
  cacheGet,
  cacheSet,
  hashText,
} from './cache.js';
import type { DecisionInput, EntityType } from './types.js';

interface ExtractionResult {
  entities: Array<{ name: string; type: EntityType; description: string }>;
  relationships: Array<{ subject: string; predicate: string; object: string }>;
}

// ─── Entity Extraction ───

const EXTRACTION_PROMPT = `Extract entities and relationships from this text about a user's work, health and daily life context.
Return ONLY valid JSON matching this schema:
{
  "entities": [{"name": "string", "type": "Person|Project|Technology|Company|Concept|Location|Medication|HealthCondition|Food|Other", "description": "string"}],
  "relationships": [{"subject": "string", "predicate": "string", "object": "string"}]
}

RULES — INCLUDE:
- Real people (colleagues, founders, users)
- Software projects, products, companies
- Tools, frameworks, libraries (e.g. "React", "Prisma", "Redis")
- High-level concepts (e.g. "Open Finance", "PIX", "GraphRAG")
- Locations, organizations
- Medications (e.g. "Risperidona", "Valproic Acid", "Alprazolam", "Biperideno") — use generic/canonical name when clear
- Health conditions, symptoms and diagnoses (e.g. "ADHD", "autism", "lack of motivation", "chewing difficulty")
- Treatments and care (e.g. "CAPS", "therapy", "occupational therapy")
- Foods tied to health or preference (e.g. "sweet potato", "mashed dishes", "soft cheese")

RULES — SKIP (do NOT extract these):
- Function names: getElapsed(), hasActiveWork(), handleVaultRequest()
- CLI flags: --dangerously-skip-permissions, --effort, cwd=/tmp
- Field names: memory_id, event_id, id_field
- Port numbers: port 3334, port 3333
- Git commits/branches: commit 89b569a, endurance, gabriel_changes
- Version strings: v8.0, v1.2.3
- Fictional characters, TV/movie/game content
- URL fragments, file paths, timestamps, IP addresses
- Vague meta-labels: "humanos (temporariamente)", "response format change", "documentation examples"
- Type "Other" unless clearly a real entity with lasting relevance
- System UI elements (menu bars, notifications, window titles)

Entity names must be human-readable. If unsure, skip it.
Description must be non-empty and explain WHY this entity matters to the user's work, health or wellbeing.
Normalize medication names to a canonical form (e.g. "Risperidona", not "respiridone" typo) and prefer a single node per medication/condition/food.

Predicate vocabulary: WORKS_ON, USES, OWNS, MANAGES, DEPENDS_ON, RELATED_TO, LOCATED_IN, PART_OF, CREATED, PREFERS, DECIDED_FOR, DECIDED_AGAINST, TAKES, TREATS, CAUSES, AFFECTS, MANAGES_SYMPTOM

Text: `;

export async function extractEntities(text: string): Promise<ExtractionResult> {
  const cacheKey = `extraction:${hashText(text)}`;

  // Check cache first (OpenAI calls are billed per token)
  const cached = await cacheGet<ExtractionResult>(cacheKey);
  if (process.env.LAIN_BENCH === '1') {
    console.log(JSON.stringify({
      tag: '[bench]', ts: Date.now(), file: 'graphrag',
      func: 'extractEntities', cache_hit: !!cached,
    }));
  }
  if (cached) return cached;

  try {
    // Bounded generation: entity JSON is small; the cap bounds worst-case
    // latency on the remember path (truncation falls through to empty below).
    const result = await runFastLlmJson<ExtractionResult>(EXTRACTION_PROMPT + text, { maxTokens: 2048 });
    await cacheSet(cacheKey, result, CACHE_TTL_EXTRACTION);
    return result;
  } catch (err) {
    console.error('[graphrag] Entity extraction failed:', err instanceof Error ? err.message : err);
    return { entities: [], relationships: [] };
  }
}

// ─── Decision Auto-Detection ───

const DECISION_PATTERNS = [
  /\b(decidimos|decidiu|decidi)\b/i,
  /\b(escolhemos|escolheu|escolhi)\b/i,
  /\b(optamos|optou|optei)\b/i,
  /\b(we decided|i decided|decided to)\b/i,
  /\b(we chose|i chose|chose to)\b/i,
  /\b(we opted|i opted|opted for)\b/i,
  /\b(went with|going with)\b/i,
  /\b(picked|selected)\b/i,
];

const DECISION_EXTRACTION_PROMPT = `Extract the decision from this text. Return ONLY valid JSON:
{
  "name": "short decision title",
  "description": "what was being decided",
  "options": ["option1", "option2"],
  "criteria": ["criterion1", "criterion2"],
  "chosen": "the chosen option",
  "reasoning": "why this was chosen",
  "confidence": 0.8,
  "relatedEntities": [{"name": "entity", "type": "Person|Project|Technology|Company|Concept|Location|Medication|HealthCondition|Food|Other"}]
}

If you cannot extract a clear decision, return {"skip": true}.

Text: `;

export function containsDecisionLanguage(text: string): boolean {
  return DECISION_PATTERNS.some(pattern => pattern.test(text));
}

export async function extractDecision(text: string): Promise<DecisionInput | null> {
  try {
    const result = await runFastLlmJson<DecisionInput & { skip?: boolean }>(DECISION_EXTRACTION_PROMPT + text, { maxTokens: 2048 });
    if ('skip' in result && result.skip) return null;
    if (!result.name || !result.chosen) return null;
    return {
      name: result.name,
      description: result.description || '',
      options: result.options || [result.chosen],
      criteria: result.criteria || [],
      chosen: result.chosen,
      reasoning: result.reasoning || '',
      confidence: result.confidence ?? 0.5,
      relatedEntities: result.relatedEntities,
    };
  } catch (err) {
    console.error('[graphrag] Extract decision error:', err);
    return null;
  }
}
