/**
 * Chat-turn extraction.
 *
 * A conversation is not a memory. The model’s reply (plot summaries, advice,
 * trivia) must not become a card. This module reads the two roles, keeps only
 * durable facts the user stated or explicitly accepted, and saves each fact
 * verbatim — Mem0 must not decompose the turn again.
 *
 * Each fact also carries a short title (ideal 3 words, max 6) generated in
 * the SAME extractor call — no extra LLM round-trip. The title is metadata
 * only: the fact body stays verbatim (inferFalse is untouched).
 *
 * Fail closed: if extraction throws, the transcript is not saved.
 */

import { addMemoryWithConflictCheck, setMemoryFeedback, type FeedbackKind } from './mem0.js';
import { setImportance as stateSetImportance, setRelevance as stateSetRelevance } from './memory-state.js';
import { runFastLlmJson } from './llm-client.js';

export const MAX_CHAT_FACTS = 5;
export const MAX_CHAT_FACT_CHARS = 320;

/** Title budget: ideal 3 words, hard cap 6. */
export const TITLE_IDEAL_WORDS = 3;
export const TITLE_MAX_WORDS = 6;

/** Voice of the model. Wins even when the sentence also mentions the user. */
export const ASSISTANT_VOICE =
  /\b(assistente|assistant|o modelo|a ia|segundo o assistente|according to the assistant)\b/i;

/** Extractor is instructed to phrase every kept fact about the person. */
export const USER_ANCHOR = /\b(usu[aá]rio|user|lucas)\b/i;

const GREETING =
  /^(oi|ol[aá]|obrigad[oa]|valeu|kk+|haha+|ok|certo|entendi|beleza|sim|isso|fechado)[.!?\s]*$/i;

export interface ChatTurnInput {
  /** What the person said. Not the assistant reply. */
  user: string;
  assistant?: string;
  project?: string;
  /** Calendar day of the turn, YYYY-MM-DD. Context for the extractor only. */
  date?: string;
  /** Tenant scope. Master (`lucas`) reproduces the legacy shape. */
  tenant?: string;
}

export interface ChatFact {
  /** Verbatim durable fact (single short sentence, contains "o usuário"). */
  text: string;
  /** Short display title: ideal 3 words, max 6, no "o usuário". */
  title: string;
  /** Extractor relevance 1-5. Always set after normalizeChatFactPairs. */
  relevance?: number;
  /** Extractor kind. Always set after normalizeChatFactPairs. */
  kind?: FeedbackKind;
  /** True for mental health, crisis, grief, substance use. Set after normalization. */
  sensitive?: boolean;
}

/** Rating carried alongside a fact (extractor origin record + state write). */
export interface ChatFactRating {
  relevance: number;
  kind: FeedbackKind;
  sensitive: boolean;
}

/**
 * Rating criteria for extractor-rated chat facts. Exported because Tarefa C
 * reuses the same scale when backfilling old memories. Kept short — it ships
 * inside every extraction prompt.
 */
export const CHAT_FACT_RATING_CRITERIA =
  `Relevância (1-5): 1 = detalhe passageiro do dia; 2 = episódio pontual mas digno de registro; 3 = hábito ou preferência estável; 4 = fato importante e duradouro; 5 = central na vida da pessoa (saúde, remédios, diagnóstico, pessoas próximas, moradia, trabalho). ` +
  `Kind: "state" é estado transitório ("está com dor na têmpora hoje", "dormiu mal ontem"); "fact" é o resto ("tem psiquiatra pelo SUS", "mora com a mãe"). ` +
  `Sensitive: true para saúde mental, crise, luto e uso de substâncias; false para o resto.`;

/** Normalize an extractor rating. Invalid → defaults; the fact is never dropped for this. */
export function sanitizeChatRating(raw: unknown): ChatFactRating {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const r = o['relevance'];
  return {
    relevance: Number.isInteger(r) && (r as number) >= 1 && (r as number) <= 5 ? (r as number) : 3,
    kind: o['kind'] === 'state' ? 'state' : 'fact',
    sensitive: o['sensitive'] === true,
  };
}

/** Extractor relevance (1-5) → stored importance. Off-scale input → neutral 0.5. */
export function relevanceToImportance(relevance: number): number {
  switch (relevance) {
    case 1: return 0.2;
    case 2: return 0.35;
    case 3: return 0.5;
    case 4: return 0.7;
    case 5: return 0.85;
    default: return 0.5;
  }
}

export interface ChatMemoryResult {
  id: string;
  memory: string;
  title?: string;
  action?: string;
  superseded?: string[];
  reason?: string;
  score?: number;
}

type JsonRunner = <T>(prompt: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<T>;

export function acceptChatFact(text: string): boolean {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 12 || t.length > MAX_CHAT_FACT_CHARS) return false;
  if (GREETING.test(t)) return false;
  if (ASSISTANT_VOICE.test(t)) return false;
  if (!USER_ANCHOR.test(t)) return false;
  return true;
}

/** Leading anchor the title must not repeat ("O usuário toma…" → "toma…"). */
const TITLE_STRIP_LEAD = /^(?:o usuário|a usuária|o lucas)\b[,\s]*/i;
/** Leading copulas/prepositions with no display value ("está com dor…" → "dor…").
 * NOTE: no \b after the group — \b fails after accented chars (está/é/são)
 * without the unicode flag. (?=\s|$) guards whole-word instead. */
const TITLE_STRIP_FILLER =
  /^(?:está|é|são|tem|têm|foi|era|estava|ficou|fica|anda|com|sem|de|da|do|das|dos|na|no|nas|nos|em|por|para|que|e)(?=\s|$)\s*/i;
/** Leading past-marker clause ("Na época X, o usuário…" → "o usuário…"). */
const TITLE_STRIP_PAST = /^(?:na época[^,]*,|antes[^,]*,)\s*/i;

function cleanTitleText(s: string): string {
  let t = s.trim().replace(/\s+/g, ' ');
  t = t.replace(/^["'«»“”‘’*_\-–—]+\s*/, '').replace(/\s*["'«»“”‘’*_\-–—]+$/, '');
  t = t.replace(/[.!?…;:]+$/, '').trim();
  t = t.replace(TITLE_STRIP_LEAD, '');
  t = t.replace(/[.!?…;:]+$/, '').trim();
  return t;
}

const stripWordPunct = (w: string) => w.replace(/^[.,;:«»“”"'()]+|[.,;:«»“”"'()]+$/g, '');

/**
 * Archive convention: titles open capitalized ("Dor pulsante…", never
 * "dor pulsante…"). Normalization enforces this deterministically.
 */
function capitalizeTitleHead(t: string): string {
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Deterministic fallback title from the fact body: strip the past-marker
 * clause, the "o usuário" anchor and filler openers, keep the first 5 words.
 * Never empty for an accepted fact (falls back to raw head words).
 */
export function fallbackTitleFromFact(fact: string): string {
  let t = fact.trim().replace(/\s+/g, ' ').replace(/[.!?…;]+$/, '');
  t = t.replace(TITLE_STRIP_PAST, '');
  t = t.replace(TITLE_STRIP_LEAD, '');
  for (let i = 0; i < 3; i++) {
    const next = t.replace(TITLE_STRIP_FILLER, '');
    if (next === t) break;
    t = next;
  }
  const words = t.split(/\s+/).filter(Boolean).map(stripWordPunct).filter(Boolean);
  const kept = words.slice(0, 5);
  if (kept.length > 0) return capitalizeTitleHead(kept.join(' '));
  return capitalizeTitleHead(t.split(/\s+/).filter(Boolean).slice(0, 5).join(' '));
}

/**
 * Normalize an extractor-provided title: strip quotes/period/anchor,
 * truncate to TITLE_MAX_WORDS at a word boundary, fall back to the
 * fact body when the model returned nothing usable.
 */
export function normalizeChatTitle(raw: unknown, factText: string): string {
  const cleaned = typeof raw === 'string' ? cleanTitleText(raw) : '';
  if (!cleaned) return capitalizeTitleHead(fallbackTitleFromFact(factText));
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > TITLE_MAX_WORDS) {
    return capitalizeTitleHead(words.slice(0, TITLE_MAX_WORDS).map(stripWordPunct).filter(Boolean).join(' '));
  }
  return capitalizeTitleHead(cleaned);
}

/** Drop assistant voice, plot dumps, greetings, and duplicates. Cap at 5. Accepts legacy plain-string items. */
export function normalizeChatFactPairs(facts: unknown): ChatFact[] {
  if (!Array.isArray(facts)) return [];
  const out: ChatFact[] = [];
  const seen = new Set<string>();
  for (const raw of facts) {
    let text: string;
    let rawTitle: unknown;
    if (typeof raw === 'string') {
      text = raw;
      rawTitle = undefined;
    } else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if (typeof o.text !== 'string') continue;
      text = o.text;
      rawTitle = o.title;
    } else {
      continue;
    }
    const t = text.trim().replace(/\s+/g, ' ');
    if (!acceptChatFact(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rating = sanitizeChatRating(raw);
    out.push({ text: t, title: normalizeChatTitle(rawTitle, t), ...rating });
    if (out.length >= MAX_CHAT_FACTS) break;
  }
  return out;
}

/** Legacy shape: just the fact bodies. */
export function normalizeChatFacts(facts: unknown): string[] {
  return normalizeChatFactPairs(facts).map((f) => f.text);
}

/** One extraction example: synthetic turn + expected output. No real user data. */
export interface ExtractExample {
  user: string;
  assistant: string;
  facts: ChatFact[];
}

/**
 * Worked examples, one per rule. All turns are synthetic — never real
 * transcript text (privacy: this prompt ships on every extraction call).
 * Titles obey the archive convention (first letter uppercase).
 */
export const EXTRACT_EXAMPLES: ExtractExample[] = [
  {
    user: 'como isso todas as noites e nunca enjoo',
    assistant: 'Que bom! Banana assada com batata doce, ovo e queijo é um jantar e tanto.',
    facts: [{ text: 'O usuário come banana assada com batata doce, ovo e queijo todas as noites e nunca enjoa.', title: 'Banana assada toda noite', relevance: 3, kind: 'fact', sensitive: false }],
  },
  {
    user: 'me conta o que acontece no episódio 3',
    assistant: 'No episódio 3 o detetive encontra a carta e foge de moto pelo túnel.',
    facts: [],
  },
  {
    user: 'sim',
    assistant: 'Você gostou do filme?',
    facts: [],
  },
  {
    user: 'sim, muito',
    assistant: 'Você gostou de Duna 2?',
    facts: [{ text: 'O usuário gostou muito do filme Duna 2.', title: 'Gostou de Duna 2', relevance: 2, kind: 'fact', sensitive: false }],
  },
  {
    user: 'não, é minha vizinha Rita',
    assistant: 'Seria sua irmã?',
    facts: [{ text: 'O usuário tem uma vizinha chamada Rita.', title: 'Vizinha Rita', relevance: 3, kind: 'fact', sensitive: false }],
  },
  {
    user: 'fechado',
    assistant: 'Que tal caminhar 20 minutos depois do almoço?',
    facts: [{ text: 'O usuário combinou de caminhar 20 minutos depois do almoço.', title: 'Caminhada após almoço', relevance: 3, kind: 'fact', sensitive: false }],
  },
  {
    user: 'antes eu dormia 4h e vivia no café, hoje durmo 7h',
    assistant: '(sem resposta)',
    facts: [
      { text: 'Antes, o usuário dormia 4 horas por noite e tomava muito café.', title: 'Dormia 4 horas antes', relevance: 3, kind: 'fact', sensitive: false },
      { text: 'O usuário hoje dorme 7 horas por noite.', title: 'Dorme 7 horas hoje', relevance: 2, kind: 'state', sensitive: false },
    ],
  },
  {
    user: 'acordei com dor de cabeça',
    assistant: '(sem resposta)',
    facts: [{ text: 'O usuário acordou com dor de cabeça.', title: 'Dor de cabeça', relevance: 1, kind: 'state', sensitive: false }],
  },
  {
    user: 'fiz a cirurgia do calcanhar em junho, uns 3 dias depois do acidente',
    assistant: '(sem resposta)',
    facts: [{ text: 'O usuário fez cirurgia do calcanhar em junho/2026, cerca de 3 dias depois do acidente.', title: 'Cirurgia calcanhar junho', relevance: 5, kind: 'fact', sensitive: false }],
  },
  {
    user: 'ontem internei pelo tornozelo',
    assistant: '(sem resposta)',
    facts: [{ text: 'O usuário foi internado pelo tornozelo em 13/11/2026.', title: 'Internação tornozelo novembro', relevance: 4, kind: 'fact', sensitive: false }],
  },
];

/**
 * Render examples in the SAME shape as the real turn below
 * (PESSOA / ASSISTENTE blocks + → JSON). Fenced as another project so the
 * model copies the format without extracting the examples as facts.
 */
export function renderExamples(examples: ExtractExample[] = EXTRACT_EXAMPLES): string {
  return examples
    .map((ex) => `PESSOA:\n${ex.user}\n\nASSISTENTE:\n${ex.assistant}\n→ ${JSON.stringify({ facts: ex.facts })}`)
    .join('\n\n');
}

export function buildChatExtractPrompt(input: ChatTurnInput): string {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const assistant = (input.assistant ?? '').trim() || '(sem resposta)';
  return `Você extrai fatos duráveis de um turno de conversa para a memória de longo prazo de uma pessoa.

Regras:
- Só entra o que a PESSOA afirmou ou aceitou de forma explícita.
- A fala do assistente não é fato. Resumo de episódio, fala de personagem, trivia, conselho, opinião do assistente, saudação e pergunta saem.
- Mas USE a fala do assistente para duas coisas: (a) resolver referentes — se a pessoa disser "isso", "essa mistura", "ele", "lá", escreva o nome explícito do prato/pessoa/lugar como aparece no turno ou na fala do assistente; (b) detectar proposta concreta aceita com "sim/isso/fechado".
- Só resolva o referente se o nome estiver ESCRITO no turno ou na fala do assistente. Palpite do assistente em forma de pergunta ("Seria o seu irmão?", "Você vai ao sítio?") não confirmado pela pessoa NÃO conta — nesse caso devolva lista vazia.
- Um "sim", "isso" ou "fechado" só vira fato se o assistente fez uma proposta concreta e a pessoa aceitou. Escreva a proposta com nomes explícitos, não o "sim".
- Estado do dia (dor, humor, sono de ontem) entra como kind "state" com relevância 1-2. Se não houver nada sobre a pessoa, devolva lista vazia.
- Preservar o tempo verbal: nunca converta passado em presente. Se a pessoa marcou passado ("antes", "antigamente", "vivia", "sentia", "tinha", "na época", "quando", "resultou em"), o fato tem que carregar o marcador com as palavras da pessoa no início ("Antes...", "Na época do surto,...") — sem adjetivos novos — e usar pretérito. Quando a pessoa disser a relação de causa ("resultou em", "por causa disso"), ela precisa aparecer no fato. Sem marcador de presente ("hoje", "agora", "ainda", "continuo"), sintoma, rotina ou estado relatado no passado fica no passado.
- Passado e presente misturados viram fatos separados, cada um com seu tempo.
- A data da conversa é quando foi dito, não quando aconteceu. Não use a data da conversa como data do evento sem indicação explícita da pessoa.
- Quando a pessoa disser QUANDO aconteceu (relativo: "ontem", "semana passada", "há 5 meses", "3 dias depois"; ou absoluto: "em junho", "dia 10"), converta para data absoluta usando a Data da conversa como âncora e inclua no texto do fato (ex: "em junho/2026", "em 13/11/2026"). Sem quando explícito, não invente data nenhuma.
- Cada fato é um objeto {"text","title","relevance","kind","sensitive"}.
- "text": UMA frase curta, em português, sobre a pessoa, e deve conter "o usuário".
- "text" precisa fazer sentido SOZINHO, sem ler a conversa. Teste: se o fato contiver pronome ou demonstrativo sem referente explícito ("isso", "essa mistura", "ele"), está errado — reescreva com o nome explícito.
- "title": título curtíssimo do fato em português, ideal ${TITLE_IDEAL_WORDS} palavras, máximo ${TITLE_MAX_WORDS}. Primeira letra maiúscula. Sem "o usuário", sem aspas, sem ponto final. Substantivo na frente quando der.
- ${CHAT_FACT_RATING_CRITERIA}
- No máximo ${MAX_CHAT_FACTS}. Sem "o assistente comentou", sem roteiro, sem citação de diálogo.
- Não invente: só use nomes que aparecem no turno ou na fala do assistente.

Exemplos de OUTRO projeto (nunca extraia deles, só copie o formato):

${renderExamples()}

Data da conversa: ${date}

PESSOA:
${input.user.trim()}

ASSISTENTE:
${assistant}

Responda só JSON: {"facts":[{"text":"...","title":"...","relevance":3,"kind":"fact","sensitive":false}]}`;
}

/** Prefixo dos digests semanais — nunca entra no backfill de títulos. */
export const BUNDLE_PREFIX = '[Bundle:';

/** Backfill candidate: real text, not a bundle digest, still untitled. */
export function isTitleCandidate(item: { memory?: unknown; title?: unknown }): boolean {
  if (typeof item.memory !== 'string' || !item.memory.trim()) return false;
  if (item.memory.trimStart().startsWith(BUNDLE_PREFIX)) return false;
  return item.title == null;
}

/**
 * Standalone title prompt for the backfill: same model, same rules as the
 * extractor (ideal 3, max 6, PT, no "o usuário"), but the fact arrives
 * without its original turn — so no turn-dependent instructions.
 */
export function buildTitlePrompt(factText: string): string {
  return `Dê um título curtíssimo em português para este fato de memória de longo prazo.

Regras: ideal ${TITLE_IDEAL_WORDS} palavras, máximo ${TITLE_MAX_WORDS}. Primeira letra maiúscula. Sem "o usuário", sem aspas, sem ponto final. Substantivo na frente quando der. Só use palavras do fato — não invente.

Fato: ${factText.trim()}

Responda só JSON: {"title":"..."}`;
}

/**
 * Rate a lone fact body (no original turn — used by the backfill). Same
 * criteria as the extractor, no duplicated text. Throws on an unusable
 * model response so the caller can log-and-skip instead of writing defaults.
 */
export function buildFactRatingPrompt(factText: string): string {
  return `Avalie este fato de memória de longo prazo de uma pessoa.

${CHAT_FACT_RATING_CRITERIA}

Fato: ${factText.trim()}

Responda só JSON: {"relevance":3,"kind":"fact","sensitive":false}`;
}

/** True when the model response carries at least one usable rating field. */
export function hasAnyRatingField(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o['relevance'] !== undefined || o['kind'] !== undefined || o['sensitive'] !== undefined;
}

export async function rateChatFact(
  factText: string,
  runJson: JsonRunner = runFastLlmJson,
): Promise<ChatFactRating> {
  const res = await runJson<unknown>(buildFactRatingPrompt(factText), {
    maxTokens: 512, // JSON minúsculo, mas o modelo às vezes divaga antes dele
    temperature: 0,
  });
  if (!hasAnyRatingField(res)) {
    throw new Error(`rateChatFact: unusable rating response for: ${factText.slice(0, 80)}`);
  }
  return sanitizeChatRating(res);
}

export async function extractChatFacts(
  input: ChatTurnInput,
  runJson: JsonRunner = runFastLlmJson,
): Promise<ChatFact[]> {
  const user = input.user.trim();
  if (!user) return [];
  const result = await runJson<{ facts?: unknown }>(buildChatExtractPrompt(input), {
    maxTokens: 1536, // facts now carry title + relevance/kind/sensitive
    temperature: 0,
  });
  return normalizeChatFactPairs(result?.facts);
}

/** Ids that mean "no new memory was stored" — titles must not attach to them. */
const NON_STORED_IDS = new Set(['noop', 'duplicate', 'blocked', 'rejected', 'unknown']);

/**
 * Extract, then save each fact alone (conflict check, no Mem0 split, no bundle).
 * The title is stored as feedback metadata after the save (merge — never
 * touches the verbatim body). Importance/kind/sensitive come from the
 * extractor rating and are persisted via memory-state right after each save.
 * Empty extraction is a NOOP. Extractor failure throws — the transcript is
 * not stored.
 */
export async function rememberChatTurn(
  input: ChatTurnInput,
  deps?: {
    extract?: (input: ChatTurnInput) => Promise<ChatFact[]>;
    save?: (fact: string, project: string | undefined, title?: string, rating?: ChatFactRating) => Promise<ChatMemoryResult[]>;
    /** State persistence seam (default: memory-state). Injected in tests. */
    writeState?: (id: string, state: { importance: number; kind: FeedbackKind; sensitive: boolean; relevance: number }) => Promise<void>;
  },
): Promise<ChatMemoryResult[]> {
  const extract = deps?.extract ?? extractChatFacts;
  const save = deps?.save ?? (async (fact, project, title, rating) => {
    const rows = await addMemoryWithConflictCheck(fact, project, {
      inferFalse: true,
      chatAtom: true,
      metadata: {
        source: 'chat',
        chat_date: input.date ?? new Date().toISOString().slice(0, 10),
        // Origin record: how the extractor rated this fact.
        ...(rating ? { chat_relevance: rating.relevance, chat_kind: rating.kind, chat_sensitive: rating.sensitive } : {}),
      },
    }, input.tenant);
    // Persist the title as feedback metadata (merge — never touches the
    // verbatim body). Best-effort: a title failure never fails the save.
    if (title) {
      for (const row of rows) {
        if (row.id && !NON_STORED_IDS.has(row.id)) {
          try {
            await setMemoryFeedback(row.id, { title });
          } catch { /* title is metadata — never fails the save */ }
        }
      }
    }
    return rows;
  });
  const writeState = deps?.writeState ?? (async (id, s) => {
    await stateSetImportance(id, s.importance);
    await setMemoryFeedback(id, { kind: s.kind, sensitive: s.sensitive });
    // Rated marker: lets the backfill skip memories the extractor already rated.
    await stateSetRelevance(id, s.relevance);
  });

  let facts: ChatFact[];
  try {
    facts = await extract(input);
  } catch (err) {
    console.error('[chat-extract] failed closed, transcript not saved:', err instanceof Error ? err.message : err);
    throw err;
  }

  if (facts.length === 0) {
    return [{ id: 'noop', memory: '', action: 'NOOP', reason: 'no durable user facts', superseded: [] }];
  }

  const saved: ChatMemoryResult[] = [];
  for (const fact of facts) {
    const rating = sanitizeChatRating(fact);
    const rows = await save(fact.text, input.project, fact.title, rating);
    for (const row of rows) {
      // Surface the stored title on the result (a custom save may already set it).
      const existing = (row as Partial<ChatMemoryResult>).title;
      if (row.id && !NON_STORED_IDS.has(row.id) && fact.title && !existing) {
        saved.push({ ...row, title: fact.title });
      } else {
        saved.push({ ...row });
      }
      // Extractor-owned state. Best-effort: the memory is already saved, so a
      // state failure logs the id and lets the turn succeed — Tarefa C
      // reprocesses memories left without a note.
      if (row.id && !NON_STORED_IDS.has(row.id)) {
        await writeState(row.id, {
          importance: relevanceToImportance(rating.relevance),
          kind: rating.kind,
          sensitive: rating.sensitive,
          relevance: rating.relevance,
        }).catch((err) => console.error(
          `[chat-extract] state write failed for ${row.id}, reprocess later:`,
          err instanceof Error ? err.message : String(err),
        ));
      }
    }
  }
  return saved;
}
