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
