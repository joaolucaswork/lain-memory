/**
 * Mem0 Memory Backend
 *
 * Wraps the Mem0 SDK to provide semantic long-term memory.
 * Organizes memories by user (global) and project (scoped).
 *
 * Entity scheme:
 *   - "lucas"         → global preferences/facts
 *   - "lucas:lain"    → project-specific memories
 *   - "lucas:kapso"   → project-specific memories
 */

import { Memory, OpenAILLM, OpenAIEmbedder } from 'mem0ai/oss';
import * as graphrag from './graphrag.js';
import { getRedis, isRedisAvailable } from './redis.js';
import { INSTANCE_ID, listProjects } from './workspace.js';
import { withDistributedLock } from './distributed-lock.js';
import { classifyMemoryAction } from './contradiction-detector.js';
import { incrementMetric } from './mem-metrics.js';
import { BOILERPLATE_PATTERNS } from './memory-patterns.js';

/** Budget limits for spawn-context composition (see getContextForSpawn). */
export interface MemoryLimits {
  globalLimit: number;
  projectLimit: number;
  graphEnabled: boolean;
}

let client: Memory | null = null;

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

  return Math.min(score, 5);
}

/**
 * Decide whether pre-save Haiku enrichment may run for a memory.
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
 * Accept a Haiku rewrite ONLY when it (a) preserved the original verbatim
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
 * Score halves every 30 days since last update (or creation).
 * Returns 1.0 for missing dates (neutral — no penalty for undated memories).
 * Returns 1.0 for future dates (clock skew tolerance).
 *
 * Formula: 2^(-daysOld / 30)
 * Day 0 → 1.00, Day 30 → 0.50, Day 60 → 0.25, Day 90 → 0.125
 */
export function ageDecayScore(
  createdAt: string | undefined,
  updatedAt?: string | undefined,
  importance?: number
): number {
  const reference = updatedAt ?? createdAt;
  if (!reference) return 1.0;
  const refMs = new Date(reference).getTime();
  if (isNaN(refMs)) return 1.0;
  const daysOld = (Date.now() - refMs) / (1000 * 60 * 60 * 24);
  if (daysOld <= 0) return 1.0;
  // High-importance memories use longer halfLife to protect them from premature decay
  const halfLifeDays = (importance !== undefined && importance >= 0.8) ? 180 : 30;
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
 * Formula: 0.5·cosine + 0.3·ageDecay + 0.2·importance + termBoost (capped at 1.0)
 * Importance defaults to 0.5 (neutral) when not yet scored.
 */
export function applyAgeDecayToResults<T extends { id?: string; score?: number; created_at?: string; updated_at?: string; importance?: number | null }>(
  results: T[],
  queryTerms?: string[]
): (T & { adjustedScore: number })[] {
  const protectedCount = results.filter(r => (r.importance ?? 0) >= 0.8).length;
  if (protectedCount > 0) {
    console.log(`[mem0:decay] ${protectedCount}/${results.length} memories protected (importance >= 0.8, halfLife=180d)`);
  }
  const withAdjusted = results.map(r => {
    const cosine = r.score ?? 0.5;
    const decay = ageDecayScore(r.created_at, r.updated_at, r.importance ?? undefined);
    const importance = r.importance ?? IMPORTANCE_DEFAULT; // null → 0.5 neutral
    const termBoost = queryTerms ? termPresenceBoost((r as any).memory ?? (r as any).content ?? '', queryTerms) : 0;
    return {
      ...r,
      adjustedScore: Math.min(1.0, 0.5 * cosine + 0.3 * decay + 0.2 * importance + termBoost),
    };
  });
  return withAdjusted.sort((a, b) => b.adjustedScore - a.adjustedScore);
}

// ─── Memory Tier Classification ───

export type MemoryTier = 'hot' | 'warm' | 'cold';

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
// BOILERPLATE_PATTERNS imported from ./memory-patterns.js

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

const SCREENPIPE_NOISE_PATTERNS: RegExp[] = [
  // Generic app usage without project context.
  // NOTE: terminal emulators (Ghostty) are intentionally NOT hard-blocked here.
  // "was using Ghostty to run npm run dev ..." is legitimate work content.
  // Terminal usage is filtered by the context-aware pattern below, which
  // exempts any observation carrying a work signal.
  /was using (?:Central de Controle|Central de Notificações|Finder|Notes|Supercharge|Raycast|Amie|Dia|Ajustes do Sistema|App Store|Music|Messages|Mensagens|Safari|Desktop|Calendar|Mail|Photos|Fotos|Preview|Calculator|AnyDesk|UserNotificationCenter)\b/i,
  // Screenpipe "was using X" observations without work context (no code/project/technical terms).
  // The negative lookahead is a deterministic work-signal keyword/regex list: project names,
  // dev verbs, plus code-forensic markers (file paths, source-file extensions, "line N",
  // function-name + parens, package-manager run commands).
  /^Lucas was (?:using|on screen)\b(?!.*(?:\b(?:reino|lain|kapso|supabase|stripe|vercel|deploy|commit|merge|PR|pull request|endpoint|API|OAuth|auth|migration|schema|database|query|webhook|terraform|docker|kubernetes|pipeline|CI\/CD|build|test|debug|implement|refactor|fix|feature|branch|sprint|ticket|KAN-|JIRA|npm|bun|yarn|pnpm)\b|\b(?:line)\s+\d+\b|\b[\w/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|swift|py|go|rs|java|sql|json|yaml|yml|sh)\b|\b\w+\s*\(\s*\)|\b\w+\/\w+\/\S+))/i,
  // Battery/system status
  /\bbattery level\b.*\d+%/i,
  // OCR gibberish (2+ non-pipe OCR-specific chars, or pipe + OCR char in same text)
  /[®•©™][\s\S]*[®•©™|]|[|][\s\S]*[®•©™]/,
  // File browsing observations
  /was using Finder to (?:view|browse|open)\b/i,
  // Window/app switching noise
  /\b(?:traffic light button|energy source battery|Wi-Fi.*Bluetooth.*AirDrop)\b/i,
  // Notification center observations (Instagram, personal notifications)
  /\b(?:Notification Center|notification.*Instagram|notification.*WhatsApp.*\d+ minutes? ago)\b/i,
  // Generic app viewing with no actionable detail
  /was (?:using|viewing)\s+(?:Chrome|Google Chrome|Telegram|WhatsApp)\s+(?:on|to view|to access)\b(?!.*\b(?:OAuth|auth|API|deploy|PR|commit|endpoint|webhook|config|migration|Supabase|Stripe|Vercel|pipeline)\b)/i,
];

const TRIVIA_PATTERNS: RegExp[] = [
  // Wikipedia content
  /\bWikipedia\s+(?:article|page|navigation)\b/i,
  /\bavailable in \d+ languages\b/i,
  /\b(?:table of contents|interlanguage links|section headings)\b/i,
  // Generic tech facts (mascots, history, general knowledge)
  /\b(?:became the official mascot|released under .+ License)\b/i,
  // Generic ML/AI textbook content
  /\b(?:transformer-based models|trained on vast datasets|billions of parameters)\b/i,
  // Technology history summaries (not project-specific)
  /\b(?:successor to|predecessor of)\b.*\b(?:technology|technologies|protocol)\b/i,
  // Wikipedia maintenance
  /\b(?:maintenance templates|editorial not|stub article)\b/i,
  // Generic programming history (X was created by Y in Z)
  /\bwas created by\b.*\bin \d{4}\b/i,
  // Generic framework/tech comparisons (X uses Y while Z uses W)
  /\bwhile\b.*\b(?:both are|both is|are popular|is popular)\b/i,
  // Textbook definitions (An X is a Y for Z)
  /^An?\s+[A-Z][A-Za-z\s()]+\bis\s+a\s+(?:set of|type of|collection of|form of|way of)\b/i,
  // Generic database/SQL textbook
  /\b(?:SQL|NoSQL)\s+databases?\s+(?:use|support|provide)\b.*\b(?:transactions|scalability|consistency)\b/i,
];

const CONVERSATIONAL_NOISE_PATTERNS: RegExp[] = [
  // "User says/asks/mentions" without technical content (no project/date context)
  /^User (?:says|asks|mentions)\s+(?!.*\b(?:on \d{1,2}\s+\w+ \d{4}|reino|lain|kapso|implemented|deployed|configured)\b)['"]?.+['"]?$/i,
  // Short personal statements
  /^User (?:says that|notes that)\s+\w+\s+is\s+\w+$/i,
];

const SESSION_NOISE_PATTERNS: RegExp[] = [
  // Bare task completion (just ID + "completed")
  /^Task [a-f0-9]{6,}\s+(?:was |)completed\.?$/i,
  // Generic server operations without context
  /^Server was (?:restarted|stopped|started)\s+via\b/i,
  // Bare Telegram/WhatsApp send confirmations
  /^(?:Buttons|Messages?|Screenshots?)\s+(?:were|was)\s+sent\s+via\s+(?:Telegram|WhatsApp)\b/i,
  // Sprint restart noise
  /^The \d+ March sprint (?:restarted|started|merged)\b/i,
  // Bare deploy/build completions
  /^(?:Deploy|Build)\s+completed\s+successfully\b/i,
  // Health check responses
  /\bHealth check\s+returned\b/i,
  // Package manager install output
  /\b(?:npm|bun|yarn|pip)\s+install\s+(?:added|completed|resolved)\b/i,
  // Bare git output without context
  /^git\s+(?:pull|push|fetch)\b.*(?:up to date|Everything|done)\b/i,
  // PM2 process status
  /\bPM2\s+(?:process\s+list|status)\b/i,
  // Auto-save without context
  /^Auto-saved\s+(?:session|state)\b/i,
  // Bare file list without context
  /^Files?\s+(?:modified|changed|created):/i,
  // Bare copy/run command instructions
  /^(?:Run|Copy|Execute)\s+(?:this\s+)?command:/i,
  // Bare build success
  /^Build\s+completed\s+.*0\s+errors\b/i,
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

  // Penalize screenpipe noise (strong penalty — bonuses should not override)
  for (const pattern of SCREENPIPE_NOISE_PATTERNS) {
    if (pattern.test(text)) {
      score -= 10;
      break; // One match is enough
    }
  }

  // Penalize trivia/Wikipedia content
  for (const pattern of TRIVIA_PATTERNS) {
    if (pattern.test(text)) {
      score -= 5;
      break;
    }
  }

  // Penalize conversational noise
  for (const pattern of CONVERSATIONAL_NOISE_PATTERNS) {
    if (pattern.test(text)) {
      score -= 5;
      break;
    }
  }

  // Penalize session noise
  for (const pattern of SESSION_NOISE_PATTERNS) {
    if (pattern.test(text)) {
      score -= 5;
      break;
    }
  }

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
  // +2 decision language (PT-BR + EN) — requires subject/project context to avoid boosting trivia
  if (/\b(?:Lucas|we|I|Lain)\s+(?:decidimos|escolhemos|optamos|decided|chose|opted|designed|configured|implemented|resolved|fixed|completed|created|added|deployed|migrated|extended|updated|enhanced|improved|upgraded|conducted|recorded|learned)\b/i.test(text)) score += 2;
  // +2 preference/communication language (only with specific project/technical context)
  // Note: must\s+be and always\s+use are in META_BEHAVIORAL_PATTERNS (penalized instead)
  if (/\b(prefers?|preferência|requires?|requer)\b/i.test(text)) {
    const hasSpecificContext = /\b(?:reino-capital|lain|kapso|supabase|stripe|vercel|nextjs|typescript|postgresql|redis|qdrant|prisma|bun|react|graphql|openai|anthropic|claude|docker|kubernetes|terraform|whatsapp|telegram)\b/i.test(text);
    if (hasSpecificContext) score += 2;
  }
  // +2 project-specific names (known projects)
  if (/\b(?:reino-capital|lain|kapso|LainApp|Lain)\b/i.test(text)) score += 2;
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
  // +1 structured prefix like [Seed:] or [Project:]
  if (/^\[.+?\]/.test(text)) score += 1;
  // -2 too short + no specifics
  if (text.length < 25 && !/\d/.test(text) && !/[A-Z][a-z]/.test(text)) score -= 2;

  // Actionability bonus/penalty for technical memories (Patch 8)
  const actionability = scoreActionability(text);
  const hasContext = /\b(decided|chose|fixed|resolved|configured|implemented|completed|designed|because|due to|after|on \d{1,2}\s+\w+ \d{4})\b/i.test(text);
  if (actionability === 1 && !hasContext) score -= 2;  // Vague technical reference without context
  else if (actionability >= 4) score += 2;             // Complete with auth/example
  // actionability 2-3: neutral (has some detail but not complete)

  return score;
}

export interface AddMemoryOpts {
  /** Skip quality scoring (for callers that already filter, like seed-extraction). */
  skipQualityCheck?: boolean;
  /** Skip contradiction detection (for consolidation, seed-extraction, etc.) */
  skipConflictCheck?: boolean;
  /** Treat input as a bundle/summary — informs LLM to prefer UPDATE over NOOP for overlapping atoms. */
  bundleMode?: boolean;
  /**
   * Verbatim mode (mode:raw). Passes infer:false to the Mem0 SDK (no
   * gpt-4o-mini decomposition) AND bypasses pre-save Haiku enrichment
   * entirely (see shouldEnrichTechnicalMemory). The stored text is exactly
   * the input — 0 bytes changed. Previously enrichment still ran here and
   * could rewrite/fabricate before Mem0 ever saw the text.
   */
  inferFalse?: boolean;
}

// Symbol used to guard against double-patching the OpenAILLM prototype
const kGatewayPatch = Symbol.for('lain.mem0.gatewayPatch');

function installGatewayPatch() {
  const proto = OpenAILLM.prototype as any;
  if (proto[kGatewayPatch]) return;
  const original = proto.generateResponse;
  proto.generateResponse = async function(messages: unknown, responseFormat: any, tools: unknown) {
    if (responseFormat?.type === 'json_object') {
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: 'mem0_response',
          strict: false,
          schema: { type: 'object', additionalProperties: true, properties: {} },
        },
      };
    }
    return original.call(this, messages, responseFormat, tools);
  };
  proto[kGatewayPatch] = true;
}

// ─── Retry Helper (item #3 — exponential backoff on 429/5xx) ───

type DelayFn = (ms: number) => Promise<void>;
const DEFAULT_DELAY: DelayFn = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b429\b|5\d\d/.test(err.message);
}

/**
 * Retry wrapper with exponential backoff for transient HTTP errors.
 * Retries on 429 (rate-limit) and 5xx (server error) only.
 * Rethrows immediately on any other error class.
 * delayFn is injectable so tests do not sleep.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number; delayFn?: DelayFn }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const delay = opts?.delayFn ?? DEFAULT_DELAY;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
      const jitter = Math.random() * 0.5 * baseDelayMs;
      await delay(baseDelayMs * Math.pow(2, attempt) + jitter);
    }
  }
  throw lastErr;
}

const kEmbedderGatewayPatch = Symbol.for('lain.mem0.embedderGatewayPatch');
const kEmbedderOriginal = Symbol.for('lain.mem0.embedderOriginal');

function installEmbedderGatewayPatch(baseURL: string, providerPin?: Record<string, unknown>) {
  const proto = OpenAIEmbedder.prototype as any;
  if (proto[kEmbedderGatewayPatch]) return;
  // Capture the TRUE pristine methods once, ever — so re-patching (after a guard
  // reset, e.g. in tests) always wraps the original, never a previous wrapper.
  if (!proto[kEmbedderOriginal]) {
    proto[kEmbedderOriginal] = { embed: proto.embed, embedBatch: proto.embedBatch };
  }
  const originalEmbed = proto[kEmbedderOriginal].embed;
  const originalEmbedBatch = proto[kEmbedderOriginal].embedBatch;
  function ensureGatewayClient(this: any) {
    if (this._gatewayClientReplaced) return;
    const OpenAIClass = this.openai.constructor;
    const rawClient = new OpenAIClass({ apiKey: this.openai.apiKey, baseURL });
    if (providerPin) {
      const origCreate = rawClient.embeddings.create.bind(rawClient.embeddings);
      rawClient.embeddings.create = (params: any, opts?: any) => origCreate({ ...params, ...providerPin }, opts);
    }
    this.openai = rawClient;
    this._gatewayClientReplaced = true;
  }
  proto.embed = async function(text: string) {
    ensureGatewayClient.call(this);
    return withRetry(() => originalEmbed.call(this, text));
  };
  proto.embedBatch = async function(texts: string[]) {
    ensureGatewayClient.call(this);
    return withRetry(() => originalEmbedBatch.call(this, texts));
  };
  proto[kEmbedderGatewayPatch] = true;
}

export function buildMem0Config() {
  // Unified LLM resolution (llm-client schema): LAIN_LLM_* wins, legacy
  // AI_GATEWAY_* is the fallback. With no LAIN_LLM_* set the result is
  // identical to the pre-unification behavior.
  const gatewayKey  = process.env.LAIN_LLM_API_KEY || process.env.AI_GATEWAY_API_KEY;
  const gatewayBase = process.env.LAIN_LLM_BASE_URL
    || process.env.AI_GATEWAY_BASE_URL
    || (gatewayKey ? 'https://ai-gateway.vercel.sh/v1' : undefined);
  const openaiKey   = process.env.LAIN_OPENAI_API_KEY;
  const useGateway  = Boolean(gatewayKey);
  const apiKey      = useGateway ? gatewayKey : openaiKey;
  // Mem0's internal LLM (fact extraction) and embeddings models. Explicit
  // LAIN_LLM_MODEL / LAIN_EMBED_MODEL win; otherwise keep the previous
  // gateway-prefixed vs bare defaults (NOT LAIN_FAST_MODEL — that drives the
  // chat client in llm-client.ts and may name a non-OpenAI model).
  const embedModel  = process.env.LAIN_EMBED_MODEL
    ?? (useGateway ? 'openai/text-embedding-3-small' : 'text-embedding-3-small');
  const llmModel    = process.env.LAIN_LLM_MODEL
    ?? (useGateway ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
  if (useGateway) {
    installGatewayPatch();
    const isOpenRouter = Boolean(gatewayBase) && (() => {
      try { return new URL(gatewayBase!).hostname.endsWith('openrouter.ai'); }
      catch { return false; }
    })();
    installEmbedderGatewayPatch(
      gatewayBase!,
      isOpenRouter ? { provider: { order: ['openai'] } } : undefined,
    );
  }
  return {
    embedder: {
      provider: 'openai' as const,
      config: { apiKey, model: embedModel, ...(useGateway ? { baseURL: gatewayBase } : {}) },
    },
    llm: {
      // NOTE (verified against mem0ai 3.3.1 dist/oss source): the OpenAI LLM
      // class sends no max_tokens and no provider routing — only apiKey,
      // baseURL, model, timeout are honored. So mem0's internal extraction
      // can't be latency-pinned from here; bound it via LAIN_LLM_MODEL choice.
      // Deliberately no `timeout`: a slow extraction should delay, not fail,
      // the save (fail-fast here would lose the memory).
      provider: 'openai' as const,
      config: { apiKey, model: llmModel, ...(useGateway ? { baseURL: gatewayBase } : {}) },
    },
  };
}

function getClient(): Memory {
  if (!client) {
    const qdrantHost = process.env.QDRANT_HOST || 'localhost';
    const qdrantPort = parseInt(process.env.QDRANT_PORT || '6333', 10);

    if (!process.env.LAIN_OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY && !process.env.LAIN_LLM_API_KEY) {
      throw new Error('LAIN_LLM_API_KEY (or LAIN_OPENAI_API_KEY / AI_GATEWAY_API_KEY) not set — required for Mem0 OSS embeddings');
    }

    const { embedder, llm } = buildMem0Config();

    client = new Memory({
      embedder,
      vectorStore: {
        provider: 'qdrant',
        config: {
          host: qdrantHost,
          port: qdrantPort,
          collectionName: INSTANCE_ID ? `mem0-${INSTANCE_ID}` : 'mem0',
          ...(process.env.LAIN_QDRANT_API_KEY ? { apiKey: process.env.LAIN_QDRANT_API_KEY } : {}),
        },
      },
      llm,
      disableHistory: true,
    });
  }
  return client;
}

function userId(project?: string): string {
  return project ? `lucas:${project}` : 'lucas';
}

export async function addMemory(text: string, project?: string, opts?: AddMemoryOpts): Promise<{ id: string; event_id?: string; memory: string; action?: string; superseded?: string[]; reason?: string; score?: number }[]> {
  // Pre-save enrichment BEFORE quality gate, for API memories missing detail.
  // Gated by shouldEnrichTechnicalMemory: never for verbatim (inferFalse) or
  // non-API notes. Acceptance is value-based (acceptEnrichedMemory), NOT
  // length-based — see those helpers for the rationale.
  let enrichedText = text;
  if (shouldEnrichTechnicalMemory(text, opts)) {
    try {
      const { runHaikuFast } = await import('./llm-client.js');
      const enriched = await withRetry(() => runHaikuFast(
        `This technical memory describes an HTTP API but is missing actionable detail.
Fill in ONLY details that are unambiguously implied by the original.

HARD CONSTRAINTS:
- Do NOT invent URLs, headers, hosts, tokens, or curl commands.
- If the input is a simple technical note rather than an API spec, return it UNCHANGED with no additions.
- If a detail is not present or unambiguously implied by the original, omit it — never fabricate API structures.
- Preserve all original information verbatim.
Return ONLY the resulting text, no explanation.

Original: ${text}`
      ));
      if (acceptEnrichedMemory(text, enriched)) {
        enrichedText = enriched;
        console.log(`[mem0] Enriched API memory (actionability: ${scoreActionability(text)} → ${scoreActionability(enriched)})`);
      } else if (enriched) {
        // Visible so a future enrichment regression is not silent.
        console.log(`[mem0] Rejected enrichment (no actionable gain or introduced a fabricated URL); keeping original verbatim`);
      }
    } catch (err) {
      // Fire-and-forget: if enrichment fails, continue with original
      console.log(`[mem0] Enrichment failed, using original:`, err instanceof Error ? err.message : err);
    }
  }

  // Quality gate: reject low-quality saves before hitting Mem0 API (scored on enriched text)
  if (!opts?.skipQualityCheck) {
    // C4: check boilerplate first so we can surface the specific pattern in reason
    let boilerplateReason: string | undefined;
    for (const pattern of BOILERPLATE_PATTERNS) {
      if (pattern.test(enrichedText)) {
        boilerplateReason = `matched boilerplate pattern: ${pattern.source}`;
        break;
      }
    }
    if (boilerplateReason) {
      console.log(`[mem0] Rejected boilerplate memory: ${enrichedText.slice(0, 80)}...`);
      incrementMetric('memoriesRejected');
      return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: boilerplateReason, score: 0 }];
    }
    const quality = scoreMemoryQuality(enrichedText);
    if (quality < MIN_MEMORY_QUALITY) {
      console.log(`[mem0] Rejected low-quality memory (score=${quality}): ${enrichedText.slice(0, 80)}...`);
      incrementMetric('memoriesRejected');
      return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: 'actionability score below threshold', score: quality }];
    }
  }

  const m = getClient();
  const result = await m.add(
    [{ role: 'user', content: enrichedText }],
    { userId: userId(project), ...(opts?.inferFalse ? { infer: false } : {}) }
  );

  incrementMetric('memoriesAdded');
  // Fire-and-forget: async graph ingestion + cache invalidation
  graphrag.ingest(enrichedText, project).catch(err =>
    console.error('[graphrag] ingestion error:', err)
  );
  invalidateMem0Cache(project).catch(() => {});

  const items = result.results ?? [];
  const mapped = items.map((item: any) => ({
    id: item.id ?? 'unknown',
    memory: item.memory ?? text,
  }));

  // Fire-and-forget: score and store importance for each saved memory
  for (const item of mapped) {
    if (item.id && item.id !== 'unknown') {
      (async () => {
        const score = scoreImportance(enrichedText);
        await setMemoryImportance(item.id, score);
        console.log(`[mem0] Importance scored: ${score.toFixed(2)} for ${item.id.slice(0, 8)}…`);
      })().catch(() => {});
    }
  }

  return mapped;
}

// Common PT-BR function words and accented characters used to detect Portuguese text.
const PT_BR_MARKERS = /\b(?:não|uma|para|com|que|por|isso|está|foi|são|tem|seu|sua|dos|das|pelo|pela|quando|onde|também|então|porque|você|gente)\b/i;

/**
 * Heuristic: detect if text is likely Portuguese (pt-BR).
 * Returns 'pt-BR' if confident, undefined if ambiguous.
 * No external dependency — pure regex on common PT-BR function words.
 */
function detectLanguageHint(text: string): string | undefined {
  if (!text) return undefined;
  const matches = (text.match(PT_BR_MARKERS) || []).length;
  // Require at least 2 hits to avoid false positives on short/technical texts
  return matches >= 2 ? 'pt-BR' : undefined;
}

/**
 * Add memory with conflict detection.
 * Searches for similar existing memories, classifies the relationship, and handles:
 * - ADD: save normally
 * - UPDATE/DELETE: supersede old memories, then save
 * - NOOP: skip (duplicate)
 */
export async function addMemoryWithConflictCheck(
  text: string,
  project?: string,
  opts?: AddMemoryOpts
): Promise<{ id: string; event_id?: string; memory: string; action?: string; superseded?: string[]; conflictsWith?: { id: string; snippet: string; score: number }[]; reason?: string; score?: number }[]> {
  if (opts?.skipConflictCheck) {
    return addMemory(text, project, opts);
  }

  // Search for similar existing memories
  let similarMemories: { id: string; memory: string; score: number }[] = [];
  try {
    const results = await searchMemory(text, project, 5);
    similarMemories = results
      .filter(r => (r.score ?? 0) > 0.5)
      .map(r => ({ id: r.id, memory: r.memory, score: r.score ?? 0 }));
  } catch (err) {
    console.log('[mem0] Conflict check search failed, proceeding with ADD:', err);
  }

  // Classify the action — pass language hint to improve bilingual conflict detection
  const langHint = detectLanguageHint(
    text + (similarMemories[0]?.memory ?? '')
  );
  const classification = await classifyMemoryAction(text, similarMemories, langHint, opts?.bundleMode);
  console.log(`[mem0] Conflict check: ${classification.action} — ${classification.reason}`);

  // Log to maintenance
  try {
    const { logMaintenance } = await import('./maintenance-log.js');
    logMaintenance('conflict_check', {
      action: classification.action,
      reason: classification.reason,
      supersedes: classification.supersedes,
      newMemory: text.slice(0, 100),
      project,
    });
  } catch { /* non-critical */ }

  if (classification.action === 'NOOP') {
    if (process.env.LAIN_BENCH === '1') {
      console.log(JSON.stringify({
        tag: '[bench]', ts: Date.now(), file: 'mem0',
        func: 'addMemoryWithConflictCheck', dedup_decision: classification.action,
      }));
    }
    console.log(`[mem0] Skipping duplicate memory: ${text.slice(0, 80)}...`);
    return [{
      id: 'duplicate',
      memory: text,
      action: 'NOOP',
      superseded: [],
      conflictsWith: similarMemories.map(m => ({
        id: m.id,
        snippet: (m.memory || '').slice(0, 120),
        score: m.score,
      })),
    }];
  }

  if (process.env.LAIN_BENCH === '1') {
    console.log(JSON.stringify({
      tag: '[bench]', ts: Date.now(), file: 'mem0',
      func: 'addMemoryWithConflictCheck', dedup_decision: classification.action,
    }));
  }
  // Save the new memory first — only supersede old ones if save succeeded
  const result = await addMemory(text, project, opts);

  if (classification.supersedes.length > 0 && result[0] && result[0].id !== 'rejected') {
    for (const oldId of classification.supersedes) {
      try {
        await deleteMemory(oldId);
        console.log(`[mem0] Superseded memory ${oldId}`);
      } catch (err) {
        console.error(`[mem0] Failed to supersede ${oldId}:`, err);
      }
    }
  }

  return result.map(r => ({
    ...r,
    action: classification.action,
    superseded: classification.supersedes,
  }));
}

/**
 * Calibrated default for LAIN_MIN_RECALL_SCORE.
 *
 * Derived from 5 benchmark dumps (2026-05-21). Score-distribution analysis:
 *   - Junk top-1 scores (na-01..na-05): 0.215, 0.337, 0.355, 0.447*, 0.571*
 *     (* = 429-contaminated runs only — Qdrant returned noise instead of nothing)
 *   - Genuine hit min scores (ka-* / ra-*): 0.358 (ka-03, lowest), ..., 0.735
 *
 * Gap: na-05 tops at 0.355, ka-03 hits at 0.358 — a 0.003-wide separation.
 * 0.356 sits in this gap: filters na-01/na-02/na-05 reliably, keeps all genuine hits.
 *
 * TRADEOFF (documented explicitly): na-03 (0.447) and na-04 (0.571) are not
 * suppressed — doing so would require threshold > 0.447 which drops ka-03 (0.358),
 * ka-10 (0.402), and ra-03 (0.404). Those contaminated scores appear only in 2/5
 * runs; clean runs return no results for those queries.
 *
 * PROVISIONAL — calibrated from 429-contaminated dumps; re-validate after clean
 * re-ingestion. Set LAIN_MIN_RECALL_SCORE=0 to disable.
 */
export const DEFAULT_MIN_RECALL_SCORE = 0.356;

/**
 * Filter search results by a minimum score threshold.
 * When minScore <= 0 the filter is disabled and all results are returned.
 * At-threshold results are kept (>= semantics).
 */
export function applyMinScoreFilter<T extends { score?: number }>(results: T[], minScore: number): T[] {
  if (minScore <= 0) return results;
  return results.filter(r => (r.score ?? 0) >= minScore);
}

export function resolveMinRecallScore(env: NodeJS.ProcessEnv = process.env): number {
  return parseFloat(env.LAIN_MIN_RECALL_SCORE ?? String(DEFAULT_MIN_RECALL_SCORE)) || 0;
}

export async function searchMemory(query: string, project?: string, limit: number = 10): Promise<{ id: string; memory: string; score?: number; created_at?: string; updated_at?: string }[]> {
  const m = getClient();
  const result = await m.search(query, {
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve timestamps from Mem0 response for age-decay scoring
  const mapped = (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    score: item.score,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
  }));
  return applyMinScoreFilter(mapped, resolveMinRecallScore());
}

// ─── Redis-backed Mem0 Cache ───

const MEM0_CACHE_TTL = 300; // 5 minutes

function mem0CacheKey(query: string, project?: string): string {
  const normalized = `${query}:${project || ''}`.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `cache:mem0:${hash}`;
}

/**
 * Search memory with Redis cache. Falls back to direct API call if Redis unavailable.
 * Cache hit: ~0.5ms vs API call: ~200-500ms.
 */
export async function cachedSearchMemory(query: string, project?: string, limit: number = 10): Promise<{ id: string; memory: string; score?: number; created_at?: string; updated_at?: string }[]> {
  const key = mem0CacheKey(query, project);

  // Try cache first
  if (isRedisAvailable()) {
    try {
      const cached = await getRedis().get(key);
      if (cached) {
        incrementMetric('cacheHits');
        return JSON.parse(cached);
      }
    } catch (err) {
      // Cache read failed — fall through to API
    }
  }
  incrementMetric('cacheMisses');

  // Cache miss — call Mem0 API
  const results = await searchMemory(query, project, limit);

  // Boost recently-accessed memories by using touch timestamp as virtual updated_at
  let boostedResults = results;
  if (isRedisAvailable()) {
    try {
      boostedResults = await Promise.all(
        results.map(async (r) => {
          const touchTs = await getMemoryTouchTimestamp(r.id);
          if (touchTs) {
            const touchDate = new Date(touchTs).toISOString();
            // Use touch timestamp if more recent than actual updated_at
            const currentUpdated = r.updated_at ? new Date(r.updated_at).getTime() : 0;
            if (touchTs > currentUpdated) {
              return { ...r, updated_at: touchDate };
            }
          }
          return r;
        })
      );
    } catch {
      // Boost failed — use original results
    }
  }

  // Fetch importance scores from Redis for composite ranking
  let withImportance = boostedResults;
  if (isRedisAvailable()) {
    try {
      withImportance = await Promise.all(
        boostedResults.map(async (r) => {
          const importance = await getMemoryImportance(r.id);
          return { ...r, importance };
        })
      );
    } catch {
      // Importance fetch failed — use defaults (0.5 neutral)
    }
  }

  const queryTerms = query.split(/\s+/).filter(t => t.length >= 3);
  const withDecay = applyAgeDecayToResults(withImportance, queryTerms);

  // Touch top-3 results to boost their relevance (fire-and-forget)
  // touchMemoryTimestamp also reinforces importance score
  for (const r of withDecay.slice(0, 3)) {
    if (r.id) touchMemoryTimestamp(r.id).catch(() => {});
  }

  // Cache the result
  if (isRedisAvailable()) {
    getRedis().set(key, JSON.stringify(withDecay), 'EX', MEM0_CACHE_TTL).catch(() => {});
  }

  return withDecay;
}

// ─── Importance Scoring (Poignancy) ───

const IMPORTANCE_TTL = 365 * 24 * 60 * 60; // 1 year
const IMPORTANCE_DEFAULT = 0.5; // neutral when not scored

/**
 * Score the importance/poignancy of a memory — puramente algorítmico, sem LLM.
 * Retorna valor em [0.1, 1.0] (arredondado para 1 casa decimal).
 *
 * Sinais pontuados (aditivos):
 *   +0.20 base (toda memória começa aqui)
 *   +0.20 keywords críticas (urgente, crash, hotfix, incident, etc.)
 *   +0.10 keywords de bug/erro
 *   +0.15 keywords de decisão/preferência
 *   +0.10 padrões de data
 *   +0.10 nomes próprios do projeto (Lucas, Lain, Stripe, Supabase, etc.)
 *   +0.10 valores monetários/numéricos grandes
 *   +0.10 URL (quando text > 80 chars)
 *   +0.05 lista de nomes próprios
 *   +0.05 texto longo (> 150 chars)
 *   -0.10 ações triviais de UI em texto curto (< 80 chars)
 */
export function scoreImportance(text: string): number {
  if (!text) return IMPORTANCE_DEFAULT;
  let score = 0.20;
  if (/\b(critical|urgente?|emerg\u00ean[c\u00e7]ia|crash|falhou|failed|caiu|bug\s+cr\u00edtico|hotfix|incident)\b/i.test(text)) score += 0.20;
  if (/\b(bug|erro|error|problema|problem|issue)\b/i.test(text)) score += 0.10;
  if (/\b(decided?|chose|opted?|designed|configured|implemented|resolved|fixed|deployed|prefers?|prefer\u00eancia|always\s+use|must\s+be|decidimos|escolhemos|optamos|prefere|preferem|gosta\s+de|n\u00e3o\s+gosta)\b/i.test(text)) score += 0.15;
  if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[-\/]\d{2}[-\/]\d{2}/.test(text)) score += 0.10;
  if (/\b(Lucas|Lain|reino-capital|kapso|WhatsApp|Telegram|Stripe|Supabase|Qdrant|Vercel|OpenAI|Anthropic|Claude)\b/i.test(text)) score += 0.10;
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

/**
 * Persist importance score for a memory ID in Redis.
 */
export async function setMemoryImportance(memoryId: string, score: number): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().set(`mem0:importance:${memoryId}`, score.toString(), 'EX', IMPORTANCE_TTL);
  } catch { /* non-critical */ }
}

/**
 * Get stored importance score for a memory ID.
 * Returns null if not yet scored (key absent from Redis).
 * Returns IMPORTANCE_DEFAULT only on error or Redis unavailable.
 */
export async function getMemoryImportance(memoryId: string): Promise<number | null> {
  if (!isRedisAvailable()) return IMPORTANCE_DEFAULT;
  try {
    const val = await getRedis().get(`mem0:importance:${memoryId}`);
    if (val === null) return null; // not yet scored
    const score = parseFloat(val);
    return isNaN(score) ? IMPORTANCE_DEFAULT : score;
  } catch { return IMPORTANCE_DEFAULT; }
}

/**
 * Bump importance slightly when a memory is accessed.
 * Implements usage-based reinforcement: frequently used memories become more important.
 * Cap at 1.0.
 */
export async function reinforceMemoryImportance(memoryId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const current = await getMemoryImportance(memoryId);
    if (current === null) return; // not yet scored — don't set 0.5+0.05 as if it were scored
    const bumped = Math.min(1.0, current + 0.05);
    await setMemoryImportance(memoryId, bumped);
  } catch { /* non-critical */ }
}

// ─── Relevance Boost (touch on retrieval) ───

const TOUCH_TTL = 30 * 24 * 60 * 60; // 30 days

/**
 * Record that a memory was accessed/used.
 * Stores last-access timestamp in Redis. When computing age decay,
 * this effectively "refreshes" the memory's recency.
 * Also reinforces importance score.
 */
export async function touchMemoryTimestamp(memoryId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().set(`mem0:touch:${memoryId}`, Date.now().toString(), 'EX', TOUCH_TTL);
    // Fire-and-forget: reinforce importance on access
    reinforceMemoryImportance(memoryId).catch(() => {});
  } catch { /* non-critical */ }
}

/**
 * Get the last access timestamp for a memory (if touched).
 * Returns null if never accessed or Redis unavailable.
 */
export async function getMemoryTouchTimestamp(memoryId: string): Promise<number | null> {
  if (!isRedisAvailable()) return null;
  try {
    const ts = await getRedis().get(`mem0:touch:${memoryId}`);
    return ts ? parseInt(ts, 10) : null;
  } catch { return null; }
}

// ─── Memory Cleanup (memoryScan) ───

/**
 * Scan project memories and delete those that are cold AND low quality.
 * Safety rules:
 *   - Only deletes project-scoped memories (global memories are permanent)
 *   - Only deletes memories > 90 days old (3x the cold threshold — extra safety margin)
 *   - Only deletes memories with quality score < 3 (low-value content)
 *   - Returns a report of what was deleted
 */
export async function scanAndCleanProjectMemories(project: string): Promise<{
  total: number;
  deleted: number;
  deletedItems: { id: string; memory: string; daysOld: number }[];
}> {
  const memories = await getMemories(project, 200);
  const deletedItems: { id: string; memory: string; daysOld: number }[] = [];

  for (const mem of memories) {
    const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : null;
    if (!createdMs || isNaN(createdMs)) continue;
    const daysOld = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    if (daysOld < 90) continue; // extra safety margin — only 90+ days
    const quality = scoreMemoryQuality(mem.memory);
    if (quality >= 3) continue; // keep quality memories even if old
    await deleteMemory(mem.id);
    deletedItems.push({ id: mem.id, memory: mem.memory.slice(0, 80), daysOld: Math.round(daysOld) });
  }

  if (deletedItems.length > 0) {
    await invalidateMem0Cache(project);
  }

  try {
    const { logMaintenance } = await import('./maintenance-log.js');
    logMaintenance('memory_scan', {
      project,
      total: memories.length,
      deleted: deletedItems.length,
      deletedItems: deletedItems.map(d => ({ memory: d.memory, daysOld: d.daysOld })),
    });
  } catch { /* non-critical */ }

  return { total: memories.length, deleted: deletedItems.length, deletedItems };
}

/**
 * Invalidate Mem0 cache for a project when memories change (add/delete/consolidate).
 * Uses key prefix scan to clear all cached queries for the project.
 */
export async function invalidateMem0Cache(project?: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    // SCAN needs explicit keyPrefix in match; returned keys include prefix so strip before del
    const p = INSTANCE_ID ? `lain:${INSTANCE_ID}:` : 'lain:';
    const stream = getRedis().scanStream({ match: `${p}cache:mem0:*`, count: 100 });
    const keysToDelete: string[] = [];
    for await (const keys of stream) {
      keysToDelete.push(...(keys as string[]));
    }
    if (keysToDelete.length > 0) {
      const pipeline = getRedis().pipeline();
      for (const k of keysToDelete) {
        pipeline.del(k.slice(p.length));
      }
      await pipeline.exec();
    }
  } catch (err) {
    // Non-critical — cache will expire naturally
  }
}

export async function getMemories(project?: string, limit: number = 20): Promise<{ id: string; memory: string; created_at?: string; updated_at?: string }[]> {
  const m = getClient();
  const result = await m.getAll({
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve created_at/updated_at from Mem0 response
  return (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
  }));
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const m = getClient();
  await m.delete(memoryId);
  invalidateMem0Cache().catch(() => {});
}

// C3: Update an existing memory by ID. Uses Mem0 SDK native update.
// OSS Memory.update(id, string) takes a plain string and returns { message: string }.
// ID is preserved (in-place update). No conflict check — caller asserts intentional replacement.
export async function updateMemory(memoryId: string, newText: string, project?: string): Promise<{ id: string; memory: string }> {
  const m = getClient();
  await m.update(memoryId, newText);
  invalidateMem0Cache(project).catch(() => {});
  return { id: memoryId, memory: newText };
}

// ─── Memory Consolidation (Patch 2) ───

/**
 * Group memories by topic prefix or semantic similarity.
 * Returns groups of 2+ related memories that can be consolidated.
 */
function groupMemories(memories: { id: string; memory: string }[]): Map<string, { id: string; memory: string }[]> {
  const groups = new Map<string, { id: string; memory: string }[]>();

  // First pass: group by [Seed: <title>] prefix
  const ungrouped: { id: string; memory: string }[] = [];
  for (const mem of memories) {
    const seedMatch = mem.memory.match(/^\[Seed:\s*(.+?)\]/);
    if (seedMatch) {
      const key = `seed:${seedMatch[1].toLowerCase().trim()}`;
      const group = groups.get(key) || [];
      group.push(mem);
      groups.set(key, group);
    } else {
      ungrouped.push(mem);
    }
  }

  // Second pass: group ungrouped by keyword overlap
  const used = new Set<string>();
  for (let i = 0; i < ungrouped.length; i++) {
    if (used.has(ungrouped[i].id)) continue;
    const wordsA = new Set(ungrouped[i].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const similar: { id: string; memory: string }[] = [ungrouped[i]];

    for (let j = i + 1; j < ungrouped.length; j++) {
      if (used.has(ungrouped[j].id)) continue;
      const wordsB = new Set(ungrouped[j].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
      let overlap = 0;
      for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
      const similarity = (2 * overlap) / (wordsA.size + wordsB.size);
      if (similarity >= 0.3) {
        similar.push(ungrouped[j]);
        used.add(ungrouped[j].id);
      }
    }

    if (similar.length >= 2) {
      used.add(ungrouped[i].id);
      groups.set(`topic:${i}`, similar);
    }
  }

  // Only return groups with 2+ memories
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }

  return groups;
}

/**
 * Consolidate fragmented memories for a project scope.
 * Groups related memories, merges them via gpt-4o-mini (was Claude Haiku CLI pre-2026-05-09), replaces fragments.
 * Returns { consolidated, deleted, groups }.
 */
export interface ConsolidationDetail {
  fragments: string[];
  result: string;
}

export async function consolidateMemories(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  groups: number;
  details: ConsolidationDetail[];
}> {
  const allMems = await getMemories(project, 100);
  if (allMems.length < 4) return { consolidated: 0, deleted: 0, groups: 0, details: [] };

  const groups = groupMemories(allMems);
  if (groups.size === 0) return { consolidated: 0, deleted: 0, groups: 0, details: [] };

  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  for (const [_key, group] of groups) {
    const fragmentTexts = group.map(m => m.memory);
    const fragments = fragmentTexts.join('\n- ');

    try {
      const { runFastLlmJson } = await import('./llm-client.js');
      const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
        `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
      ));

      if (result.consolidated && result.consolidated.length > 20) {
        // Quality gate: skip low-quality consolidation results (item #6)
        if (scoreMemoryQuality(result.consolidated) < MIN_MEMORY_QUALITY) {
          console.log(`[mem0] Consolidation rejected low-quality result: ${result.consolidated.slice(0, 60)}...`);
          continue;
        }
        await addMemory(result.consolidated, project, { skipQualityCheck: true, skipConflictCheck: true });
        consolidated++;

        details.push({
          fragments: fragmentTexts.map(f => f.slice(0, 120)),
          result: result.consolidated.slice(0, 200),
        });

        // Delete fragments
        for (const mem of group) {
          if (mem.id && mem.id !== 'pending') {
            try { await deleteMemory(mem.id); deleted++; } catch {}
          }
        }
      }
    } catch (err) {
      console.error(`[mem0] Consolidation failed for group:`, err);
    }
  }

  console.log(`[mem0] Consolidation: ${consolidated} groups merged, ${deleted} fragments deleted`);
  return { consolidated, deleted, groups: groups.size, details };
}

// ─── Progressive Context (Patch 5 → v2: dynamic char budget) ───

const DEFAULT_MAX_CONTEXT_CHARS = 6000;

/**
 * Get formatted memory context for Claude spawner.
 * Progressive loading: prioritizes by relevance, respects char budget.
 * Budget is dynamic based on task complexity (passed by spawner).
 * Fetches global memories + project-specific semantic search.
 */

// ─── Query Optimization (no LLM — pure text processing) ───

const QUERY_STOPWORDS = new Set([
  // Portuguese filler
  'que', 'nao', 'não', 'pra', 'pro', 'com', 'uma', 'uns', 'tem', 'tá', 'ta',
  'vai', 'vou', 'esse', 'essa', 'isso', 'isto', 'aqui', 'ali', 'ele', 'ela',
  'eles', 'elas', 'como', 'mais', 'mas', 'nos', 'nas', 'dos', 'das', 'pelo',
  'pela', 'por', 'para', 'sem', 'sob', 'sobre', 'entre', 'ate', 'até',
  'quando', 'onde', 'quem', 'qual', 'sera', 'será', 'seria', 'pode', 'deve',
  'precisa', 'caso', 'entao', 'então', 'depois', 'antes', 'ainda', 'tambem',
  'também', 'porque', 'porquê', 'voce', 'você', 'gente', 'tipo', 'coisa',
  'certo', 'bom', 'sim', 'olha', 'veja', 'faz', 'fez', 'fazer',
  'usuario', 'usuário', 'reclamando', 'falando', 'dizendo', 'pedindo',
  // English filler
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has',
  'been', 'will', 'what', 'when', 'where', 'which', 'would', 'should',
  'could', 'does', 'into', 'just', 'also', 'about', 'some', 'very',
  'need', 'want', 'check', 'look', 'see', 'know', 'think', 'make',
]);

/**
 * Extract key terms from a message for optimized memory search.
 * No LLM — pure text processing. Removes filler, keeps domain terms.
 */
function buildSearchQuery(message: string, project?: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\sáàâãéèêíìîóòôõúùûçñ]/g, ' ') // keep letters + accented chars
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ')
    .filter(w => w.length >= 3 && !QUERY_STOPWORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  // Prepend project name if available (boosts project-relevant results)
  const query = project
    ? `${project} ${unique.join(' ')}`
    : unique.join(' ');

  // If query is too short after filtering, fall back to original
  return query.length >= 5 ? query : message;
}

export async function getContextForSpawn(message: string, project?: string, charBudget?: number, limits?: MemoryLimits): Promise<string> {
  // Early exit if memory is completely disabled for this tier
  if (limits && limits.globalLimit === 0 && limits.projectLimit === 0) {
    return '';
  }

  const effectiveGlobalLimit = limits?.globalLimit ?? 15;
  const effectiveProjectLimit = limits?.projectLimit ?? 15;

  // Build optimized search query (no LLM — pure text processing)
  const searchQuery = buildSearchQuery(message, project);

  // Parallel calls with individual error handling
  const globalMemsPromise = effectiveGlobalLimit > 0
    ? (async () => {
        try {
          return await cachedSearchMemory(searchQuery, undefined, effectiveGlobalLimit) as { memory: string; score?: number }[];
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const projectMemsPromise = (project && effectiveProjectLimit > 0)
    ? (async () => {
        try {
          const t0 = Date.now();
          const results = await cachedSearchMemory(searchQuery, project, effectiveProjectLimit) as { memory: string; score?: number }[];
          if (effectiveGlobalLimit === 5 && effectiveProjectLimit === 5) {
            console.log(`[recall:simple] project memories fetched in ${Date.now() - t0}ms (${results.length} results)`);
          }
          return results;
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const [globalList, projectList] = await Promise.all([
    globalMemsPromise, projectMemsPromise,
  ]);

  // Build context with progressive loading (budget-aware)
  let budget = charBudget ?? DEFAULT_MAX_CONTEXT_CHARS;
  const globalLines: string[] = [];
  const projectLines: string[] = [];

  // 1. Global memories (highest priority — user prefs/facts)
  for (const m of globalList) {
    const line = `- ${m.memory}`;
    if (budget - line.length < 0) break;
    globalLines.push(line);
    budget -= line.length;
  }

  // 2. Project memories sorted by relevance score (higher = more relevant)
  if (projectList.length > 0) {
    const sorted = [...projectList].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const m of sorted) {
      const line = `- ${m.memory}`;
      if (budget - line.length < 0) break;
      projectLines.push(line);
      budget -= line.length;
    }
  }

  if (globalLines.length === 0 && projectLines.length === 0) return '';

  // Build output with typed block headers for clear agent navigation
  const parts: string[] = [];
  if (globalLines.length > 0) {
    parts.push('## Global (preferences & facts)');
    parts.push(...globalLines);
  }
  if (projectLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`## Project: ${project}`);
    parts.push(...projectLines);
  }

  return parts.join('\n');
}

export function isMem0Configured(): boolean {
  return !!(process.env.QDRANT_HOST || process.env.LAIN_OPENAI_API_KEY);
}

// ─── Importance Backfill ───

const BACKFILL_PROJECTS = [undefined, 'lain', 'reino-capital', 'kapso', 'reino-capital-pay', 'reino-capital-admin'] as const;

/**
 * Score up to `maxToScore` memories that are missing importance scores in Redis.
 * Called periodically by the maintenance loop to ensure all memories are scored.
 * Returns the number of memories scored.
 */
export async function backfillImportanceScores(maxToScore = 50): Promise<number> {
  let totalScored = 0;

  for (const project of BACKFILL_PROJECTS) {
    if (totalScored >= maxToScore) break;
    try {
      const memories = await getMemories(project, 200);
      for (const mem of memories) {
        if (totalScored >= maxToScore) break;
        if (!mem.id) continue;
        const existing = await getMemoryImportance(mem.id);
        if (existing !== null) continue; // already scored
        const score = scoreImportance(mem.memory);
        await setMemoryImportance(mem.id, score);
        totalScored++;
      }
    } catch { /* non-critical — skip project */ }
  }

  return totalScored;
}

// ─── Automatic Memory Maintenance ───

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
const MAINTENANCE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function startMemoryMaintenance(): void {
  if (maintenanceTimer) return;
  if (!isMem0Configured()) return;

  maintenanceTimer = setInterval(async () => {
    await withDistributedLock('mem0:maintenance', 7_200_000, async () => {
    try {
      const { logMaintenance } = await import('./maintenance-log.js');

      const consolStart = Date.now();
      const result = await consolidateMemories();
      const consolDuration = Date.now() - consolStart;
      if (result.consolidated > 0) {
        console.log(`[mem0] Auto-consolidation: ${result.consolidated} groups merged, ${result.deleted} fragments deleted`);
      }
      logMaintenance('memory_consolidation', {
        consolidated: result.consolidated,
        deleted: result.deleted,
        groups: result.groups,
        details: result.details,
      }, consolDuration);

      const { resolveEntities } = await import('./graphrag.js');
      const resolveStart = Date.now();
      const resolved = await resolveEntities();
      const resolveDuration = Date.now() - resolveStart;
      if (resolved.merged > 0) {
        console.log(`[graphrag] Auto-resolve: ${resolved.merged} duplicate entities merged`);
      }
      logMaintenance('entity_resolution', {
        merged: resolved.merged,
        total: resolved.pairs.length,
      }, resolveDuration);

      // ── Weekly auto-cleanup: runs on Sundays before 6am ──
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() < 6) {
        let weeklyDeleted = 0;
        let weeklyTotal = 0;
        const projects = listProjects().map(p => p.name);
        for (const proj of projects) {
          try {
            const scanStart = Date.now();
            const scanResult = await scanAndCleanProjectMemories(proj);
            const scanDuration = Date.now() - scanStart;
            weeklyDeleted += scanResult.deleted;
            weeklyTotal += scanResult.total;
            if (scanResult.deleted > 0) {
              console.log(`[mem0] Auto-cleanup ${proj}: ${scanResult.deleted}/${scanResult.total} deleted`);
            }
            logMaintenance('auto_cleanup', {
              project: proj,
              total: scanResult.total,
              deleted: scanResult.deleted,
            }, scanDuration);
          } catch (err) {
            console.error(`[mem0] Auto-cleanup error for ${proj}:`, err);
          }
        }
        console.log(`[mem0] Weekly auto-cleanup: ${weeklyDeleted}/${weeklyTotal} deleted across ${projects.length} projects`);
      }

      // ── Importance backfill: score memories missing importance in Redis ──
      try {
        const backfillStart = Date.now();
        const scored = await backfillImportanceScores(50);
        if (scored > 0) {
          const backfillDuration = Date.now() - backfillStart;
          console.log(`[mem0] Importance backfill: ${scored} memories scored`);
          logMaintenance('importance_backfill', { scored }, backfillDuration);
        }
      } catch (err) {
        console.error('[mem0] Importance backfill error:', err);
      }

      // ── Periodic contradiction scan: check recent global memories for conflicts ──
      try {
        const { classifyMemoryAction } = await import('./contradiction-detector.js');
        const recentGlobal = await getMemories(undefined, 20);
        let contradictionsFound = 0;

        for (const mem of recentGlobal) {
          // Skip very recent memories (< 1 hour)
          const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : Date.now();
          if (Date.now() - createdMs < 60 * 60 * 1000) continue;

          const similar = await searchMemory(mem.memory, undefined, 5);
          const others = similar
            .filter(s => s.id !== mem.id && (s.score ?? 0) > 0.6)
            .map(s => ({ id: s.id, memory: s.memory, score: s.score ?? 0 }));

          if (others.length === 0) continue;

          const classification = await classifyMemoryAction(mem.memory, others);
          if (classification.action === 'NOOP' && classification.supersedes.length === 0) {
            try {
              await deleteMemory(mem.id);
              contradictionsFound++;
              console.log(`[mem0] Maintenance: removed duplicate ${mem.id}`);
            } catch {}
          }
        }

        if (contradictionsFound > 0) {
          logMaintenance('contradiction_scan', {
            checked: recentGlobal.length,
            removed: contradictionsFound,
          });
        }
      } catch (err) {
        console.error('[mem0] Contradiction scan error:', err);
      }
    } catch (err) {
      console.error('[mem0] Maintenance error:', err);
    }
    }); // end withDistributedLock
  }, MAINTENANCE_INTERVAL_MS);

  console.log('[mem0] Memory maintenance scheduled (every 2h)');
}

export function stopMemoryMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}
