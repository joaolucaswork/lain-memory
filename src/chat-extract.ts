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

import { addMemoryWithConflictCheck, setMemoryFeedback } from './mem0.js';
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
}

export interface ChatFact {
  /** Verbatim durable fact (single short sentence, contains "o usuário"). */
  text: string;
  /** Short display title: ideal 3 words, max 6, no "o usuário". */
  title: string;
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
  if (kept.length > 0) return kept.join(' ');
  return t.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
}

/**
 * Normalize an extractor-provided title: strip quotes/period/anchor,
 * truncate to TITLE_MAX_WORDS at a word boundary, fall back to the
 * fact body when the model returned nothing usable.
 */
export function normalizeChatTitle(raw: unknown, factText: string): string {
  const cleaned = typeof raw === 'string' ? cleanTitleText(raw) : '';
  if (!cleaned) return fallbackTitleFromFact(factText);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > TITLE_MAX_WORDS) {
    return words.slice(0, TITLE_MAX_WORDS).map(stripWordPunct).filter(Boolean).join(' ');
  }
  return cleaned;
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
    out.push({ text: t, title: normalizeChatTitle(rawTitle, t) });
    if (out.length >= MAX_CHAT_FACTS) break;
  }
  return out;
}

/** Legacy shape: just the fact bodies. */
export function normalizeChatFacts(facts: unknown): string[] {
  return normalizeChatFactPairs(facts).map((f) => f.text);
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
- Se não houver nada que ainda importe na semana que vem, devolva lista vazia.
- Preservar o tempo verbal: nunca converta passado em presente. Se a pessoa marcou passado ("antes", "antigamente", "vivia", "sentia", "tinha", "na época", "quando", "resultou em"), o fato tem que carregar o marcador explícito no início ("Antes...", "Na época...") e usar pretérito. Sem marcador de presente ("hoje", "agora", "ainda", "continuo"), sintoma, rotina ou estado relatado no passado fica no passado.
- Passado e presente misturados viram fatos separados, cada um com seu tempo.
- A data da conversa é quando foi dito, não quando aconteceu. Não use a data da conversa como data do evento sem indicação explícita da pessoa.
- Cada fato é um objeto {"text","title"}.
- "text": UMA frase curta, em português, sobre a pessoa, e deve conter "o usuário".
- "text" precisa fazer sentido SOZINHO, sem ler a conversa. Teste: se o fato contiver pronome ou demonstrativo sem referente explícito ("isso", "essa mistura", "ele"), está errado — reescreva com o nome explícito.
- "title": título curtíssimo do fato em português, ideal ${TITLE_IDEAL_WORDS} palavras, máximo ${TITLE_MAX_WORDS}. Sem "o usuário", sem aspas, sem ponto final. Substantivo na frente quando der.
- No máximo ${MAX_CHAT_FACTS}. Sem "o assistente comentou", sem roteiro, sem citação de diálogo.
- Não invente: só use nomes que aparecem no turno ou na fala do assistente.

Exemplos:
- PESSOA: "como todas as noites e nunca enjoo" + ASSISTENTE citando "banana assada com batata doce, ovo e queijo" → {"facts":[{"text":"O usuário come banana assada com batata doce, ovo e queijo no almoço e no jantar e nunca enjoa.","title":"banana assada com batata doce"}]}
- PESSOA: "oi" → {"facts":[]}
- PESSOA: "sim" + ASSISTENTE: "Você gostou do filme?" → {"facts":[]}
- PESSOA: "fechado" + ASSISTENTE: "Proponho usar o Haiku 5.5 na conversa, topa?" → {"facts":[{"text":"O usuário aceitou usar o Haiku 5.5 como modelo de conversa.","title":"Haiku 5.5 como modelo"}]}
- PESSOA: "antes eu so vivia chapado, e com essa dor pulsante na têmpora, vivia fumando e trabalhando 24h, o que resultou no surto que tive" → {"facts":[{"text":"Na época agitada antes do surto, o usuário vivia chapado, tinha dor pulsante na têmpora, fumava e trabalhava 24h.","title":"época agitada antes do surto"}]}
- PESSOA: "hoje estou com dor pulsante na têmpora" → {"facts":[{"text":"O usuário está com dor pulsante na têmpora.","title":"dor pulsante na têmpora"}]}

Data da conversa: ${date}

PESSOA:
${input.user.trim()}

ASSISTENTE:
${assistant}

Responda só JSON: {"facts":[{"text":"...","title":"..."}]}`;
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

Regras: ideal ${TITLE_IDEAL_WORDS} palavras, máximo ${TITLE_MAX_WORDS}. Sem "o usuário", sem aspas, sem ponto final. Substantivo na frente quando der. Só use palavras do fato — não invente.

Fato: ${factText.trim()}

Responda só JSON: {"title":"..."}`;
}

export async function extractChatFacts(
  input: ChatTurnInput,
  runJson: JsonRunner = runFastLlmJson,
): Promise<ChatFact[]> {
  const user = input.user.trim();
  if (!user) return [];
  const result = await runJson<{ facts?: unknown }>(buildChatExtractPrompt(input), {
    maxTokens: 1024,
    temperature: 0,
  });
  return normalizeChatFactPairs(result?.facts);
}

/** Ids that mean "no new memory was stored" — titles must not attach to them. */
const NON_STORED_IDS = new Set(['noop', 'duplicate', 'blocked', 'rejected', 'unknown']);

/**
 * Extract, then save each fact alone (conflict check, no Mem0 split, no bundle).
 * The title is stored as feedback metadata after the save (merge — never
 * touches the verbatim body). Empty extraction is a NOOP. Extractor failure
 * throws — the transcript is not stored.
 */
export async function rememberChatTurn(
  input: ChatTurnInput,
  deps?: {
    extract?: (input: ChatTurnInput) => Promise<ChatFact[]>;
    save?: (fact: string, project: string | undefined, title?: string) => Promise<ChatMemoryResult[]>;
  },
): Promise<ChatMemoryResult[]> {
  const extract = deps?.extract ?? extractChatFacts;
  const save = deps?.save ?? (async (fact, project, title) => {
    const rows = await addMemoryWithConflictCheck(fact, project, {
      inferFalse: true,
      chatAtom: true,
      metadata: {
        source: 'chat',
        chat_date: input.date ?? new Date().toISOString().slice(0, 10),
      },
    });
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
    const rows = await save(fact.text, input.project, fact.title);
    for (const row of rows) {
      // Surface the stored title on the result (a custom save may already set it).
      const existing = (row as Partial<ChatMemoryResult>).title;
      if (row.id && !NON_STORED_IDS.has(row.id) && fact.title && !existing) {
        saved.push({ ...row, title: fact.title });
      } else {
        saved.push({ ...row });
      }
    }
  }
  return saved;
}
