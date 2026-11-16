/**
 * Chat-turn extraction.
 *
 * A conversation is not a memory. The model’s reply (plot summaries, advice,
 * trivia) must not become a card. This module reads the two roles, keeps only
 * durable facts the user stated or explicitly accepted, and saves each fact
 * verbatim — Mem0 must not decompose the turn again.
 *
 * Fail closed: if extraction throws, the transcript is not saved.
 */

import { addMemoryWithConflictCheck } from './mem0.js';
import { runFastLlmJson } from './llm-client.js';

export const MAX_CHAT_FACTS = 5;
export const MAX_CHAT_FACT_CHARS = 320;

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

export interface ChatMemoryResult {
  id: string;
  memory: string;
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

/** Drop assistant voice, plot dumps, greetings, and duplicates. Cap at 5. */
export function normalizeChatFacts(facts: unknown): string[] {
  if (!Array.isArray(facts)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of facts) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!acceptChatFact(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_CHAT_FACTS) break;
  }
  return out;
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
- Cada fato é UMA frase curta, em português, sobre a pessoa, e deve conter "o usuário".
- Cada fato precisa fazer sentido SOZINHO, sem ler a conversa. Teste: se o fato contiver pronome ou demonstrativo sem referente explícito ("isso", "essa mistura", "ele"), está errado — reescreva com o nome explícito.
- No máximo ${MAX_CHAT_FACTS}. Sem "o assistente comentou", sem roteiro, sem citação de diálogo.
- Não invente: só use nomes que aparecem no turno ou na fala do assistente.

Exemplos:
- PESSOA: "como todas as noites e nunca enjoo" + ASSISTENTE citando "banana assada com batata doce, ovo e queijo" → {"facts":["O usuário come banana assada com batata doce, ovo e queijo no almoço e no jantar e nunca enjoa."]}
- PESSOA: "oi" → {"facts":[]}
- PESSOA: "sim" + ASSISTENTE: "Você gostou do filme?" → {"facts":[]}
- PESSOA: "fechado" + ASSISTENTE: "Proponho usar o Haiku 5.5 na conversa, topa?" → {"facts":["O usuário aceitou usar o Haiku 5.5 como modelo de conversa."]}
- PESSOA: "antes eu so vivia chapado, e com essa dor pulsante na têmpora, vivia fumando e trabalhando 24h, o que resultou no surto que tive" → {"facts":["Na época agitada antes do surto, o usuário vivia chapado, tinha dor pulsante na têmpora, fumava e trabalhava 24h."]}
- PESSOA: "hoje estou com dor pulsante na têmpora" → {"facts":["O usuário está com dor pulsante na têmpora."]}

Data da conversa: ${date}

PESSOA:
${input.user.trim()}

ASSISTENTE:
${assistant}

Responda só JSON: {"facts":["..."]}`;
}

export async function extractChatFacts(
  input: ChatTurnInput,
  runJson: JsonRunner = runFastLlmJson,
): Promise<string[]> {
  const user = input.user.trim();
  if (!user) return [];
  const result = await runJson<{ facts?: unknown }>(buildChatExtractPrompt(input), {
    maxTokens: 1024,
    temperature: 0,
  });
  return normalizeChatFacts(result?.facts);
}

/**
 * Extract, then save each fact alone (conflict check, no Mem0 split, no bundle).
 * Empty extraction is a NOOP. Extractor failure throws — the transcript is not stored.
 */
export async function rememberChatTurn(
  input: ChatTurnInput,
  deps?: {
    extract?: (input: ChatTurnInput) => Promise<string[]>;
    save?: (fact: string, project: string | undefined) => Promise<ChatMemoryResult[]>;
  },
): Promise<ChatMemoryResult[]> {
  const extract = deps?.extract ?? extractChatFacts;
  const save = deps?.save ?? ((fact, project) => addMemoryWithConflictCheck(fact, project, {
    inferFalse: true,
    chatAtom: true,
    metadata: {
      source: 'chat',
      chat_date: input.date ?? new Date().toISOString().slice(0, 10),
    },
  }));

  let facts: string[];
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
    const rows = await save(fact, input.project);
    saved.push(...rows);
  }
  return saved;
}
