#!/usr/bin/env bun
// A/B dry-run: mesma leva de turnos -> extração via GLM vs Haiku. Não salva nada.
import { buildChatExtractPrompt, normalizeChatFacts } from '../src/chat-extract.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Carrega .env do repo (Bun só auto-carrega do cwd; script pode rodar de outro dir)
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  const envFile = join(dir, '..', '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
      if (v && !(k in process.env)) (process.env as any)[k] = v;
    }
  }
} catch {}

const KEY = process.env.LAIN_LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
if (!KEY) throw new Error('sem API key (LAIN_LLM_API_KEY/OPENROUTER_API_KEY)');
const BASE = (process.env.LAIN_LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

const MODELS = {
  glm: 'z-ai/glm-5.3-flash',
  haiku: 'anthropic/claude-haiku-5.5',
} as const;

// Preços /1M (input, output) p/ estimativa
const PRICE: Record<string, [number, number]> = {
  [MODELS.glm]: [0.15, 0.50],
  [MODELS.haiku]: [0.10, 0.50],
};

interface Case { name: string; user: string; assistant: string }
const CASES: Case[] = [
  { name: 'fato-simples', user: 'o usuário mora em São Paulo e prefere pagar com Pix', assistant: 'Anotado! Prefere Pix para quais compras?' },
  { name: 'saudacao', user: 'oi', assistant: 'Olá! Como posso ajudar hoje?' },
  { name: 'aceite-proposta', user: 'fechado, vamos de Haiku 5.5 pra conversa', assistant: 'Proponho usar o Haiku 5.5 como modelo de conversa e manter o GLM nas rotinas de memória. Topa?' },
  { name: 'sim-isolado', user: 'sim', assistant: 'Você gostou do filme?' },
  { name: 'assistant-dump', user: 'gostei', assistant: 'No episódio 5, o personagem principal descobre que o laboratório escondia...' + 'x'.repeat(200) },
  { name: 'multi-fato', user: 'o usuário tem dois gatos, trabalha com infra em São Paulo e está aprendendo alemão', assistant: 'Legal! Como se chamam os gatos?' },
  { name: 'opiniao-efemera', user: 'o usuário achou esse filme chato', assistant: 'Qual parte te incomodou mais?' },
  { name: 'trabalho', user: 'o usuário decidiu que o projeto diario vai usar Haiku 5.5 no chat e GLM no remember', assistant: 'Boa divisão. Quer que eu registre isso?' },
  { name: 'anafora-mistura', user: 'Eu acho interessante também, é uma mistura que me agrada bastante e como todas as noites e no almoço também, e nunca enjoo', assistant: 'Sua comida favorita é banana assada com batata doce, ovo e queijo. Você descreve o prato como uma mistura de sabores revigorante.' },
  { name: 'anafora-ele', user: 'o usuário disse que ele chega na sexta', assistant: 'Seu irmão vem te visitar na sexta?' },
  { name: 'anafora-la', user: 'o usuário vai pra lá todo sábado', assistant: 'Você vai ao sítio da sua mãe todo sábado?' },
];

function parseFacts(raw: string): unknown {
  const text = raw.trim();
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m?.[1]) { try { return (JSON.parse(m[1].trim()) as any)?.facts; } catch {} }
  try { return (JSON.parse(text) as any)?.facts; } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return (JSON.parse(text.slice(a, b + 1)) as any)?.facts; } catch {} }
  return undefined;
}

async function runModel(model: string, prompt: string) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}`, 'HTTP-Referer': 'lain-memory-compare', 'X-Title': 'compare-chat-extract' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as any;
  const raw: string = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage ?? {};
  return { raw, ms: Date.now() - t0, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 };
}

let totCost: Record<string, number> = { glm: 0, haiku: 0 };
for (const c of CASES) {
  const prompt = buildChatExtractPrompt({ user: c.user, assistant: c.assistant, date: '2026-11-14' });
  console.log(`\n=== ${c.name} ===`);
  console.log(`USER: ${c.user}`);
  for (const [tag, model] of Object.entries(MODELS)) {
    try {
      const r = await runModel(model, prompt);
      const facts = normalizeChatFacts(parseFacts(r.raw));
      const [pi, po] = PRICE[model];
      const cost = (r.promptTokens / 1e6) * pi + (r.completionTokens / 1e6) * po;
      totCost[tag] += cost;
      console.log(`[${tag}] ${r.ms}ms in=${r.promptTokens} out=${r.completionTokens} ~$${cost.toFixed(6)} facts=${JSON.stringify(facts)}`);
      if (facts.length === 0) console.log(`[${tag}] raw=${r.raw.slice(0, 160).replace(/\n/g, ' ')}`);
    } catch (e) {
      console.log(`[${tag}] ERRO: ${e instanceof Error ? e.message : e}`);
    }
  }
}
console.log(`\n--- custo estimado total do teste: glm=$${totCost.glm.toFixed(6)} haiku=$${totCost.haiku.toFixed(6)} ---`);
