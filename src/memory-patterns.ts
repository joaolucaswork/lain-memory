// Merged boilerplate patterns from mem0.ts (10 entries) and seed-extraction.ts (17 entries).
// seed-extraction.ts was the superset; all 17 entries retained here.
// mem0.ts had "all rights reserved|todos os direitos reservados" combined — kept split for count.
export const BOILERPLATE_PATTERNS: RegExp[] = [
  // Financial disclaimers (PT-BR)
  /este relat[oó]rio [eé] meramente informativo/i,
  /n[aã]o constitui oferta|n[aã]o [eé] uma oferta/i,
  /rentabilidade passada n[aã]o [eé] garantia/i,
  /investimentos envolvem riscos/i,
  /leia o prospecto antes de investir/i,
  /as informa[cç][oõ]es s[aã]o baseadas em dados dispon[ií]veis at[eé]/i,
  // Financial disclaimers (EN)
  /informational only.*not an offer/i,
  /past performance.*(?:not|no) guarantee/i,
  /not (?:a |an )?(?:offer|recommendation|solicitation)/i,
  /based on information (?:up to|available at)/i,
  /investments involve risk/i,
  // Generic methodology/boilerplate
  /treats different asset types with distinct.*calculations/i,
  /portfolio balances are based on information up to/i,
  /(?:all|the) (?:data|information) (?:is|are) (?:provided|presented) (?:as[- ]is|without warranty)/i,
  /(?:©|copyright)\s*\d{4}/i,
  /all rights reserved/i,
  /todos os direitos reservados/i,
];

// ─── Technical-memory quality helpers ───────────────────────────────────────
// Verbatim from lain memory-patterns.ts (Fase 4). Pure regex, zero deps.

const TECHNICAL_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s]+/i,                          // URL
  /\/(?:api|v\d)\/[^\s]*/i,                      // API path
  /(?:GET|POST|PUT|DELETE|PATCH)\s+\//i,          // HTTP method + path
  /\b(?:endpoint|api|url|base[_-]?url)\b/i,      // API keywords
  /\b(?:curl|wget|fetch|axios)\b/i,              // HTTP client commands
  /\b(?:localhost|127\.0\.0\.1):\d+/i,            // Local server
  /\b(?:npm|bun|yarn|pip)\s+(?:run|install)\b/i,  // Package manager commands
  /\b(?:docker|kubectl|gcloud)\s+\w+/i,           // DevOps commands
  /\b(?:config|env|\.env|secret|token|key)\b.*[:=]/i,  // Config/env vars
  /\b(?:port|host|database|db)\s*[:=]/i,           // Connection config
];

/**
 * Detect if a memory contains technical content (URLs, endpoints, commands, configs).
 */
export function isTechnicalMemory(text: string): boolean {
  return TECHNICAL_PATTERNS.some(p => p.test(text));
}

/**
 * Score actionability of a technical memory (0-5).
 * 0 = not technical, 1 = vague reference, 5 = complete example with auth.
 */
export function scoreActionability(text: string): number {
  if (!isTechnicalMemory(text)) return 0;

  let score = 1; // Base: it's technical but vague

  // +1 full URL with path (not just "API at /user")
  if (/https?:\/\/[^\s]+\/[^\s]+/.test(text)) score++;
  // +1 HTTP method specified
  if (/\b(?:GET|POST|PUT|DELETE|PATCH)\b/.test(text)) score++;
  // +1 auth info (token, header, key, bearer)
  if (/\b(?:token|bearer|api[_-]?key|authorization|header)\b/i.test(text) && /[:='"]\s*\S+/.test(text)) score++;
  // +1 complete example (curl command, code snippet, or full config)
  if (/\bcurl\b.*https?:\/\//i.test(text) || /```[\s\S]*```/.test(text) || /\{[^}]*"[\w]+"[^}]*:[^}]*\}/.test(text)) score++;

  return Math.min(score, 5);
}

/**
 * Score a fact for quality. Higher = more valuable.
 * Filters out boilerplate and scores based on specificity.
 * Verbatim from lain seed-extraction.ts (Fase 4).
 */
export function scoreFactQuality(fact: string): number {
  let score = 0;

  // Disqualify: matches known boilerplate pattern
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(fact)) return -10;
  }

  // +3 if contains named entity (capitalized multi-word or known patterns)
  if (/[A-Z][a-zà-ú]+(?:\s+[A-Z][a-zà-ú]+)+/.test(fact)) score += 3;
  // +3 if contains monetary value
  if (/R\$[\s]?[\d.,]+|USD[\s]?[\d.,]+|\$[\s]?[\d.,]+/.test(fact)) score += 3;
  // +2 if contains percentage
  if (/\d+[.,]\d+\s*%/.test(fact)) score += 2;
  // +2 if contains specific date
  if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[-\/]\d{2}/.test(fact)) score += 2;
  // +1 if contains a number (any)
  if (/\d+/.test(fact)) score += 1;
  // +1 if longer than 50 chars (more specific)
  if (fact.length > 50) score += 1;
  // -2 if too generic (no names, no numbers, short)
  if (fact.length < 30 && !/\d/.test(fact) && !/[A-Z][a-z]/.test(fact)) score -= 2;

  // Actionability modifier for technical facts (Patch 8, softer)
  const actionability = scoreActionability(fact);
  if (actionability === 1) score -= 1;        // Vague technical reference
  else if (actionability >= 4) score += 1;    // Complete with auth/example

  return score;
}
