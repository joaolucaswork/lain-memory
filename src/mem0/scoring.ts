/**
 * Pure memory scoring (mem0 split M3).
 *
 * No I/O, no LLM, no backend — deterministic heuristics only:
 * actionability/enrichment gates, age decay, tier classification,
 * pre-save quality, and importance. Sibling modules (state, read, write)
 * import from here; mem0.ts re-exports the public surface.
 */

import { BOILERPLATE_PATTERNS } from '../memory-patterns.js';
import {
  FEEDBACK_DEFAULTS as STATE_FEEDBACK_DEFAULTS,
  IMPORTANCE_DEFAULT as STATE_IMPORTANCE_DEFAULT,
} from '../memory-state.js';
import type { FeedbackKind, MemoryTier } from './types.js';

// ─── Actionability Scoring (Patch 8) ───

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
  // +1 frontend implementation detail (concrete file + code-splitting primitive).
  // WHY: API-centric signals above (URL + method + auth + curl) cap a frontend
  // plan at 1 by construction. A file ref paired with a real tech primitive
  // (React.lazy/Suspense/manualChunks) is the frontend equivalent of actionable
  // detail — counts as neutral (2), not vague (1), not complete (4+).
  if (/[A-Za-z0-9_-]+\.(?:tsx|ts|jsx|js)\b/.test(text) && /\b(?:React\.lazy|Suspense|manualChunks|prefetch|code splitting|lazy\b|bundle)\b/i.test(text)) score++;

  return Math.min(score, 5);
}

/**
 * Decide whether pre-save LLM enrichment may run for a memory.
 *
 * Enrichment is a narrow tool: it only legitimately *completes* a memory
 * that ALREADY describes an HTTP API but is missing detail. It must NEVER:
 *  - run for verbatim saves (`inferFalse` / mode:raw) — verbatim is sacred,
 *    0 bytes may change;
 *  - run when the caller opted out of quality scoring;
 *  - run for a plain technical note that is not API-shaped — there is no
 *    API structure to "complete", so the model would have to fabricate
 *    URLs/headers/curl that were never in the source (the exact bug that
 *    turned a git-hook security note into a fake `POST /git/commit`).
 */
export function shouldEnrichTechnicalMemory(
  text: string,
  opts?: { skipQualityCheck?: boolean; inferFalse?: boolean }
): boolean {
  if (opts?.skipQualityCheck) return false;
  if (opts?.inferFalse) return false; // verbatim is sacred
  if (!isTechnicalMemory(text)) return false;
  if (scoreActionability(text) > 2) return false;
  // Only an already-API-shaped memory has real endpoint detail to fill in.
  return (
    /https?:\/\/\S+/.test(text) ||
    /\b(?:GET|POST|PUT|DELETE|PATCH)\b/.test(text) ||
    /\bcurl\b/i.test(text)
  );
}

/**
 * Accept an LLM rewrite ONLY when it (a) preserved the original verbatim
 * (whitespace-normalized substring) AND (b) genuinely raised actionability.
 *
 * Length is irrelevant — the old `enriched.length > text.length` rule was
 * "trash in, trash out": it structurally rewarded a hallucinated padding
 * block. If the rewrite dropped/altered the original or added no real
 * actionable signal, the ORIGINAL wins.
 */
export function acceptEnrichedMemory(original: string, enriched: string): boolean {
  if (!enriched) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (!norm(enriched).includes(norm(original))) return false;
  // Deterministic anti-fabrication: the rewrite may NOT introduce any
  // absolute URL that was not in the original. A scheme'd URL absent from
  // the source is invented by definition — reject it even if it raised the
  // actionability score (a fabricated curl/host inflates that score too,
  // so the score gate alone is not enough). This closes the exact incident
  // class (`POST /git/commit`, fake github.com/your-repo URLs) without an
  // LLM judge.
  const originalUrls = new Set(extractAbsoluteUrls(original));
  for (const u of extractAbsoluteUrls(enriched)) {
    if (!originalUrls.has(u)) return false;
  }
  return scoreActionability(enriched) > scoreActionability(original);
}

/** Absolute http(s) URLs, trailing punctuation stripped, lower-cased. */
function extractAbsoluteUrls(s: string): string[] {
  return (s.match(/https?:\/\/[^\s'"`)\]}>]+/gi) ?? []).map(u =>
    u.replace(/[.,;:]+$/, '').toLowerCase()
  );
}

// ─── Age Decay Scoring (memoryAge) ───

/**
 * Calculate a recency decay factor for a memory.
 * Score halves every halfLifeDays since last update (or creation).
 * Returns 1.0 for missing dates (neutral — no penalty for undated memories).
 * Returns 1.0 for future dates (clock skew tolerance).
 *
 * Half-life by kind (Fase 0 feedback):
 *   importance >= 0.8 → 180d (confirmed-important, protected from decay)
 *   kind = state       → 7d  (transient: reading, feeling, doing — fades fast)
 *   kind = fact        → 90d (stable: lives-near, has-psychiatrist — persists)
 *
 * Formula: 2^(-daysOld / halfLifeDays)
 */
export function ageDecayScore(
  createdAt: string | undefined,
  updatedAt?: string | undefined,
  importance?: number,
  kind?: FeedbackKind | null,
): number {
  const reference = updatedAt ?? createdAt;
  if (!reference) return 1.0;
  const refMs = new Date(reference).getTime();
  if (isNaN(refMs)) return 1.0;
  const daysOld = (Date.now() - refMs) / (1000 * 60 * 60 * 24);
  if (daysOld <= 0) return 1.0;
  // High-importance memories use longer halfLife to protect them from premature decay
  const halfLifeDays = (importance !== undefined && importance >= 0.8) ? 180
    : kind === 'state' ? 7 : 90;
  return Math.pow(2, -daysOld / halfLifeDays);
}

/**
 * Boost score for exact term matches from the query.
 * Correct, transparent alternative to BM25 for exact keyword recall.
 */
function termPresenceBoost(memoryText: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const lowerText = memoryText.toLowerCase();
  const matches = queryTerms.filter(t => lowerText.includes(t.toLowerCase())).length;
  return (matches / queryTerms.length) * 0.1; // max +0.1 when all terms present
}

/**
 * Apply age decay to a list of search results, re-sort by adjusted score.
 * Results without timestamps are treated as neutral (decay factor = 1.0).
 * Returns the same results with an extra `adjustedScore` field, sorted descending.
 *
 * Formula: (0.5·cosine + 0.3·ageDecay_kind + 0.2·importance) · (0.5 + 0.5·confidence) + termBoost (capped at 1.0)
 * Importance defaults to 0.5 (neutral) when not yet scored.
 * Confidence defaults to 0.5 (neutral, ×0.75) — confirmed memories (1.0) keep full score.
 */
export function applyAgeDecayToResults<T extends { id?: string; score?: number; created_at?: string; updated_at?: string; importance?: number | null; confidence?: number | null; kind?: FeedbackKind | null }>(
  results: T[],
  queryTerms?: string[]
): (T & { adjustedScore: number })[] {
  const protectedCount = results.filter(r => (r.importance ?? 0) >= 0.8).length;
  if (protectedCount > 0) {
    console.log(`[mem0:decay] ${protectedCount}/${results.length} memories protected (importance >= 0.8, halfLife=180d)`);
  }
  const withAdjusted = results.map(r => {
    const cosine = r.score ?? 0.5;
    const decay = ageDecayScore(r.created_at, r.updated_at, r.importance ?? undefined, r.kind ?? undefined);
    const importance = r.importance ?? STATE_IMPORTANCE_DEFAULT; // null → 0.5 neutral
    const confidence = r.confidence ?? STATE_FEEDBACK_DEFAULTS.confidence; // null → 0.5 neutral (×0.75)
    const termBoost = queryTerms ? termPresenceBoost((r as any).memory ?? (r as any).content ?? '', queryTerms) : 0;
    return {
      ...r,
      adjustedScore: Math.min(1.0, (0.5 * cosine + 0.3 * decay + 0.2 * importance) * (0.5 + 0.5 * confidence) + termBoost),
    };
  });
  return withAdjusted.sort((a, b) => b.adjustedScore - a.adjustedScore);
}

// ─── Memory Tier Classification ───

/**
 * Classify a memory's tier based on age and scope.
 *
 * hot   → < 7 days old (always include in context)
 * warm  → 7-30 days old (include if project is relevant)
 * cold  → > 30 days old project memories (skip in auto-context; only on explicit search)
 *
 * Global (no project) memories never become cold — they contain
 * Lucas's permanent preferences and personal facts.
 */
export function classifyMemoryTier(
  createdAt: string | undefined,
  project: string | undefined,
  updatedAt?: string | undefined
): MemoryTier {
  if (!createdAt) return 'hot'; // undated → neutral, no penalty
  const reference = updatedAt ?? createdAt;
  const refMs = new Date(reference).getTime();
  if (isNaN(refMs)) return 'hot';
  const daysOld = (Date.now() - refMs) / (1000 * 60 * 60 * 24);
  if (daysOld < 7) return 'hot';
  if (!project) return 'warm'; // global memories never go cold
  if (daysOld < 30) return 'warm';
  return 'cold';
}

// ─── Quality Scoring Pré-Save (Patch 7) ───
// BOILERPLATE_PATTERNS imported from ../memory-patterns.js

const CREDENTIAL_PATTERNS: RegExp[] = [
  // Stripe keys
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/,
  // Mercado Pago test/prod tokens
  /\bTEST-[a-f0-9]{8,}(?:-[a-f0-9]+)*/,
  /\bAPP_USR-[a-f0-9]{6,}/,
  // Twilio SIDs
  /\bAC[a-f0-9]{32}\b/,
  // JWT tokens (Supabase anon/service_role keys)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
  // Plaintext passwords (word "password" followed by the value)
  /\b(?:password|senha)\s*(?:is|was|:|=)\s*[A-Za-z0-9!@#$%^&*]{12,}/i,
  // DB passwords (long alphanumeric strings after password-context words)
  /\b(?:DB|database)\s+password\s+[A-Za-z0-9]{16,}/i,
  // Client secrets (long hex/alphanum after "secret")
  /\bclient[_\s]secret\s*[:=]?\s*[A-Za-z0-9]{16,}/i,
  // Generic long secrets after auth-context words
  /\b(?:auth_token|access_token|api_key)\s*[:=]\s*[A-Za-z0-9_-]{20,}/i,
  // AWS access key IDs
  /\bAKIA[A-Z0-9]{16}\b/,
  // AWS secret access keys
  /\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{30,}/i,
  // GitHub personal access tokens (classic ghp_, fine-grained github_pat_, OAuth gho_)
  /\b(?:ghp|gho)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  // GitLab personal access tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  // Private key headers (RSA, EC, OpenSSH, DSA, generic)
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  // Connection strings with embedded passwords (postgres, mysql, mongo, redis)
  /(?:postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:]*:[^@\s]+@/i,
  // Slack webhook URLs
  /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\//,
  // Discord webhook URLs
  /discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
  // Vercel tokens
  /\bvl_[A-Za-z0-9]{20,}\b/,
  // SendGrid API keys
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  // Generic TOKEN= or SECRET= with long values
  /\b(?:VERCEL_TOKEN|SENDGRID_API_KEY|AWS_SESSION_TOKEN)\s*[:=]\s*[A-Za-z0-9_.-]{20,}/i,
  // Environment variable dumps with multiple KEY=VALUE secrets
  /\b(?:STRIPE_SECRET|DB_PASS|API_KEY|SECRET_KEY|PRIVATE_KEY)\s*[:=]\s*\S+/i,
  // Plaintext password revealed after encoding (password ... = VALUE)
  /\bpassword\b.*=\s*[A-Za-z0-9!@#$%^&*]{12,}/i,
  // OpenAI API keys
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  // Anthropic API keys
  /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/,
  // DigitalOcean tokens
  /\bdop_v1_[a-f0-9]{64}\b/,
  // npm tokens
  /\bnpm_[A-Za-z0-9]{36}\b/,
  // Cloudflare API tokens (40-char hex after context)
  /\b(?:CF_API_TOKEN|CLOUDFLARE_TOKEN)\s*[:=]\s*[A-Za-z0-9_-]{30,}/i,
  // Heroku API keys
  /\b(?:HEROKU_API_KEY)\s*[:=]\s*[a-f0-9-]{36}/i,
];

const META_BEHAVIORAL_PATTERNS: RegExp[] = [
  /^(always|never)/i,
  /CLAUDE\.md/i,
  /\balways\s+use\b/i,
  // CLAUDE.md-style behavioral directive only — anchored to start-of-string
  // so it catches imperative rules ("Must be committed before merge") but NOT
  // descriptive policy statements that merely contain "must be" mid-sentence
  // (e.g. "passwords must be minimum 20 characters" is a security decision,
  // not a behavioral directive).
  /^(?:agents?\s+)?must\s+(?:be|never|always)\b/i,
];

export const MIN_MEMORY_QUALITY = 2;

/** Credentials and boilerplate only. Chat atoms use this instead of the score rubric. */
export function disqualifyMemory(text: string): string | null {
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(text)) return `matched boilerplate pattern: ${pattern.source}`;
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return 'matched credential pattern';
  }
  return null;
}

/**
 * Score a memory text for quality before saving.
 * Blocks boilerplate and trivially short/generic content.
 */
export function scoreMemoryQuality(text: string): number {
  // Disqualify boilerplate
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(text)) return -10;
  }

  // Disqualify credentials/secrets
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return -10;
  }

  let score = 0;

  // Penalize meta-behavioral patterns (generic rules, not project-specific)
  for (const pattern of META_BEHAVIORAL_PATTERNS) {
    if (pattern.test(text)) {
      score -= 3;
      break;
    }
  }

  // +3 named entity (multi-word capitalized)
  if (/[A-Z][a-zà-ú]+(?:\s+[A-Z][a-zà-ú]+)+/.test(text)) score += 3;
  // +3 monetary value
  if (/R\$[\s]?[\d.,]+|USD[\s]?[\d.,]+|\$[\s]?[\d.,]+/.test(text)) score += 3;
  // +2 percentage
  if (/\d+[.,]\d+\s*%/.test(text)) score += 2;
  // +2 specific date
  if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[-\/]\d{2}/.test(text)) score += 2;
  // +2 decision language (PT-BR + EN)
  if (/\b(?:Lucas|we|I|Lain)\s+(?:decidimos|escolhemos|optamos|decided|chose|opted|designed|configured|implemented|resolved|fixed|completed|created|added|deployed|migrated|extended|updated|enhanced|improved|upgraded|conducted|recorded|learned)\b/i.test(text)) score += 2;
  // +2 personal/user facts (accessibility, health, behavior, communication)
  if (/\b(?:Lucas|user)\s+(?:has|have|uses?|needs?|sometimes|always|never)\s+\w/i.test(text)) score += 2;
  // +2 people names (comma-separated proper nouns suggest meeting/call participants)
  if (/[A-Z][a-zà-ú]+(?:,\s*[A-Z][a-zà-ú]+){1,}/.test(text)) score += 2;
  // +2 communication/integration tools referenced (bidirectional)
  if (/\b(?:WhatsApp|Telegram|Slack|Discord|Jira|Linear)\b/i.test(text) && /\b(?:supports?|sends?|receives?|integrat|configur|channel|webhook|automat|workflow)\b/i.test(text)) score += 2;
  // +1 any number
  if (/\d+/.test(text)) score += 1;
  // +1 longer content (more specific)
  if (text.length > 60) score += 1;
  // +1 concrete file reference (App.tsx, not prose)
  if (/[A-Za-z0-9_-]+\.(?:tsx|ts|jsx|js|css|json|md)\b/.test(text)) score += 1;
  // +1 scoped validation (route + build/typecheck/validar).
  // WHY: routes + validation verbs scope the plan the way a date does.
  if (/\s\/[a-z0-9_.-]+/.test(text) && /\b(?:build|typecheck|validar|navega)/i.test(text)) score += 1;
  // +1 structured prefix like [Seed:] or [Project:]
  if (/^\[.+?\]/.test(text)) score += 1;
  // -2 too short + no specifics
  if (text.length < 25 && !/\d/.test(text) && !/[A-Z][a-z]/.test(text)) score -= 2;

  // Actionability bonus/penalty for technical memories (Patch 8)
  const actionability = scoreActionability(text);
  // PT-BR + plan markers count as context: porque/pois/decidiu/plano/critério/
  // validar/sucesso/após carry the same "not a vague reference" signal as
  // because/decided/after. WHY: the original EN-only list penalized PT-BR
  // implementation plans that stated scope + success criteria in prose.
  const hasContext = /\b(decided|decidiu|decidimos|chose|fixed|resolved|configured|implemented|completed|designed|because|porque|pois|due to|after|ap[oó]s|plano|criterio|critério|validar|sucesso)\b|on \d{1,2}\s+\w+ \d{4}/i.test(text);
  if (actionability === 1 && !hasContext) score -= 2;  // Vague technical reference without context
  else if (actionability >= 4) score += 2;             // Complete with auth/example
  // actionability 2-3: neutral (has some detail but not complete)

  return score;
}

/**
 * Score the importance/poignancy of a memory — puramente algorítmico, sem LLM.
 * Retorna valor em [0.1, 1.0] (arredondado para 1 casa decimal).
 *
 * Serve SÓ os caminhos que não são chat (seed, add, index, bundle): memórias
 * de chat ignoram estes regex (chatAtom) e usam a relevance do extrator.
 * Por isso não há bônus de projeto/fornecedor, saúde ou pessoa aqui — nomes
 * próprios e termos pessoais são papel do extrator, não desta heurística.
 *
 * Sinais pontuados (aditivos):
 *   +0.20 base (toda memória começa aqui)
 *   +0.20 keywords críticas (urgente, crash, hotfix, incident, etc.)
 *   +0.10 keywords de bug/erro
 *   +0.15 keywords de decisão/preferência (decidiu, vai usar, ...)
 *   +0.10 padrões de data
 *   +0.10 valores monetários/numéricos grandes
 *   +0.10 URL (quando text > 80 chars)
 *   +0.05 lista de nomes próprios
 *   +0.05 texto longo (> 150 chars)
 *   -0.10 ações triviais de UI em texto curto (< 80 chars)
 *   +0.20 saúde/médico (legado pré-extrator; só afeta não-chat)
 *   +0.15 cargo/identidade (legado pré-extrator; só afeta não-chat)
 */
export function scoreImportance(text: string): number {
  if (!text) return STATE_IMPORTANCE_DEFAULT;
  let score = 0.20;
  if (/\b(critical|urgente?|emerg\u00ean[c\u00e7]ia|crash|falhou|failed|caiu|bug\s+cr\u00edtico|hotfix|incident)\b/i.test(text)) score += 0.20;
  if (/\b(bug|erro|error|problema|problem|issue|incidentes?)\b/i.test(text)) score += 0.10;
  if (/\b(decided?|decidiu|chose|opted?|designed|configured|implemented|resolved|fixed|deployed|prefers?|prefer\u00eancia|always\s+use|must\s+be|decidimos|escolhemos|optamos|prefere|preferem|gosta\s+de|n\u00e3o\s+gosta|vai\s+usar)\b/i.test(text)) score += 0.15;
  if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[-\/]\d{2}[-\/]\d{2}/.test(text)) score += 0.10;
  if (/R\$[\s]?[\d.,]+|USD[\s]?[\d.,]+|\$[\s]?[\d.,]+|\d+[.,]\d+\s*%|\b\d{5,}\b/.test(text)) score += 0.10;
  if (/https?:\/\/[^\s]+/.test(text) && text.length > 80) score += 0.10;
  if (/[A-Z][a-z\u00e0-\u00fa]+(?:,\s*[A-Z][a-z\u00e0-\u00fa]+){1,}/.test(text)) score += 0.05;
  if (text.length > 150) score += 0.05;
  if (/\b(opened|closed|clicked|scrolled|navigated|viewed|abriu|fechou|clicou)\b/i.test(text) && text.length < 80) score -= 0.10;
  // +0.20 saúde/médico (fatos permanentes de alta importância)
  if (/\b(diabetes|alergi[a-z]*|diagn[oó]stico|diagnose|doen[cç]a|medicamento|medication|blood\s+type|glicemi|insulina|hipertens[aã]o|hypertension|asma|epilepsi|condi[cç][aã]o\s+m[eé]dica|condi[cç][aã]o\s+de\s+sa[uú]de)\b/i.test(text)) score += 0.20;
  // +0.15 cargo/identidade (fatos estáveis sobre quem é a pessoa)
  if (/\b(CEO|CTO|CFO|COO|CPO|founder|co-founder|s[oó]cio|diretor|gerente|presidente|VP|head\s+of|l[ií]der\s+de|respons[aá]vel\s+por)\b/i.test(text)) score += 0.15;
  return Math.min(1.0, Math.max(0.1, Math.round(score * 10) / 10));
}
