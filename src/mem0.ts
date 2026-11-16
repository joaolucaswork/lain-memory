/**
 * Mem0 Memory Backend
 *
 * Wraps the Mem0 SDK to provide semantic long-term memory.
 * Organizes memories by user (global) and project (scoped).
 *
 * Entity scheme:
 *   - "lucas"         → global preferences/facts
 *   - "lucas:lain"    → project-specific memories
 */

import { Memory, OpenAILLM, OpenAIEmbedder } from 'mem0ai/oss';
import * as graphrag from './graphrag.js';
import { getRedis, isRedisAvailable } from './redis.js';
import {
  FEEDBACK_DEFAULTS as STATE_FEEDBACK_DEFAULTS,
  IMPORTANCE_DEFAULT as STATE_IMPORTANCE_DEFAULT,
  STATE_SNAPSHOT_KEY,
  getManyState,
  getFeedback as stateGetFeedback,
  getManyFeedback as stateGetManyFeedback,
  getImportance as stateGetImportance,
  setFeedback as stateSetFeedback,
  setImportance as stateSetImportance,
  deleteState as stateDeleteState,
  isDefaultState,
  parseStateSnapshot,
} from './memory-state.js';
import { INSTANCE_ID, listProjects } from './workspace.js';
import { withDistributedLock } from './distributed-lock.js';
import { classifyMemoryAction } from './contradiction-detector.js';
import { incrementMetric } from './mem-metrics.js';
import { BOILERPLATE_PATTERNS } from './memory-patterns.js';
import type { PolicyAuditRecord } from './memory-policy.js';
import type {
  AddMemoryOpts,
  ConsolidationDetail,
  ContradictionSweepReport,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  MemoryLimits,
  MemorySnapshot,
  MemoryTier,
  RankedMemory,
  RestoreResult,
  TrashProvenance,
} from './mem0/types.js';
export type {
  AddMemoryOpts,
  ConsolidationDetail,
  ContradictionSweepReport,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  MemoryLimits,
  MemorySnapshot,
  MemoryTier,
  RankedMemory,
  RestoreResult,
  TrashProvenance,
} from './mem0/types.js';

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
    const importance = r.importance ?? IMPORTANCE_DEFAULT; // null → 0.5 neutral
    const confidence = r.confidence ?? FEEDBACK_DEFAULTS.confidence; // null → 0.5 neutral (×0.75)
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
  // Provider is openai_structured (not openai): it forwards Mem0's
  // response_format:json_object untouched. The plain openai path goes through
  // installGatewayPatch, which rewrites the request as an empty-properties
  // json_schema — gpt-4o-mini tolerates it, Haiku does not, and Mem0's zod
  // parse then silently yields zero atoms. Verified matrix (Nov 2026):
  // openai_structured + Haiku via OpenRouter extracts normally, so the model
  // follows LAIN_LLM_MODEL again — no separate pin needed.
  const llmModel = process.env.LAIN_LLM_MODEL
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
      // Provider openai_structured forwards response_format:json_object
      // untouched (see above) — required for non-OpenAI models.
      provider: 'openai_structured' as const,
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
  // mem0 rejeita user_id com whitespace — sanitiza para projetos com espaço (ex "lain::latency fixes").
  const clean = project?.trim().replace(/\s+/g, '_');
  return clean ? `lucas:${clean}` : 'lucas';
}

export async function addMemory(text: string, project?: string, opts?: AddMemoryOpts): Promise<{ id: string; event_id?: string; memory: string; action?: string; superseded?: string[]; reason?: string; score?: number }[]> {
  // Forget-blocklist: a forgotten memory must not be re-extracted through
  // any save path (chat, index, bundle). First check — before Mem0 is touched.
  if (!opts?.skipBlocklistCheck && await isBlocklisted(text)) {
    console.log(`[mem0] Blocked re-save of forgotten memory: ${text.slice(0, 80)}...`);
    incrementMetric('memoriesBlocked');
    return [{ id: 'blocked', memory: text, action: 'NOOP', superseded: [], reason: 'forgotten memory (blocklist)', score: 0 }];
  }
  // Pre-save enrichment BEFORE quality gate, for API memories missing detail.
  // Gated by shouldEnrichTechnicalMemory: never for verbatim (inferFalse) or
  // non-API notes. Acceptance is value-based (acceptEnrichedMemory), NOT
  // length-based — see those helpers for the rationale.
  let enrichedText = text;
  if (shouldEnrichTechnicalMemory(text, opts)) {
    try {
      const { runFastLlm } = await import('./llm-client.js');
      const enriched = await withRetry(() => runFastLlm(
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

  // Quality gate: reject low-quality saves before hitting Mem0 API (scored on enriched text).
  // Chat atoms already passed extraction; only credentials/boilerplate still block them.
  if (!opts?.skipQualityCheck) {
    const hard = disqualifyMemory(enrichedText);
    if (hard) {
      console.log(`[mem0] Rejected disqualified memory: ${enrichedText.slice(0, 80)}...`);
      incrementMetric('memoriesRejected');
      return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: hard, score: 0 }];
    }
    if (!opts?.chatAtom) {
      const quality = scoreMemoryQuality(enrichedText);
      if (quality < MIN_MEMORY_QUALITY) {
        console.log(`[mem0] Rejected low-quality memory (score=${quality}): ${enrichedText.slice(0, 80)}...`);
        incrementMetric('memoriesRejected');
        return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: 'actionability score below threshold', score: quality }];
      }
    }
  }

  const m = getClient();
  const result = await m.add(
    [{ role: 'user', content: enrichedText }],
    { userId: userId(project), ...(opts?.inferFalse ? { infer: false } : {}), ...(opts?.metadata ? { metadata: opts.metadata } : {}) }
  );

  incrementMetric('memoriesAdded');
  const items = result.results ?? [];
  const mapped = items.map((item: any) => ({
    id: item.id ?? 'unknown',
    memory: item.memory ?? text,
  }));

  // Derived projection (Fase 3): Mem0 is source of truth; the graph ingest
  // is queued durably (outbox + background drain). Never fails the save.
  // Skipped for trash copies (maintenance must not pollute the graph).
  if (!opts?.skipGraphIngest) {
    graphrag.queueGraphIngest(
      enrichedText,
      project,
      mapped.map(m => m.id).filter(id => id && id !== 'unknown')
    );
  }
  invalidateMem0Cache(project).catch(() => {});

  // Fire-and-forget: score and store importance for each saved memory.
  // Chat atoms skip this entirely (shouldApplyHeuristicState): the extractor
  // owns their importance/kind — the regex heuristics must not overwrite them.
  for (const item of mapped) {
    if (item.id && item.id !== 'unknown' && shouldApplyHeuristicState(opts)) {
      persistHeuristicState(enrichedText, item.id).catch((err) => console.error(`[mem0] post-save state write failed for ${item.id}:`, err instanceof Error ? err.message : String(err)));
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
  // Snapshot doomed memories BEFORE saving — audit trail needs full texts.
  const doomed = classification.supersedes.length > 0
    ? await snapshotMemories(classification.supersedes, project)
    : [];

  // Save the new memory first — only supersede old ones if save succeeded
  const result = await addMemory(text, project, opts);

  if (doomed.length > 0 && result[0] && result[0].id !== 'rejected') {
    const newId = result[0].id;
    const trashIds: Record<string, string | null> = {};
    for (const snap of doomed) {
      try {
        const { trashId, deleted } = await trashAndDelete(snap, project, {
          reason: classification.reason,
          trigger: `conflict_check:${classification.action}`,
          replacedById: newId,
        });
        trashIds[snap.id] = trashId;
        if (deleted) {
          console.log(`[mem0] Superseded memory ${snap.id} (trash: ${trashId})`);
        } else {
          // Fail-closed: trash copy unconfirmed → original preserved, retry later.
          console.error(`[mem0] Supersede deferred for ${snap.id}: trash copy unconfirmed, original preserved`);
        }
      } catch (err) {
        console.error(`[mem0] Failed to supersede ${snap.id}:`, err);
      }
    }
    try {
      const { logMaintenance } = await import('./maintenance-log.js');
      logMaintenance('memory_supersede', {
        project: project ?? 'global',
        classification: classification.action,
        reason: classification.reason,
        deleted: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
        replaced_by: { id: newId, memory: result[0].memory },
      });
    } catch { /* non-critical */ }
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

export async function searchMemory(query: string, project?: string, limit: number = 10): Promise<RankedMemory[]> {
  const m = getClient();
  const result = await m.search(query, {
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve timestamps from Mem0 response for age-decay scoring
  // Preserve payload metadata (carries lain_feedback/lain_importance — free state).
  const mapped = (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    score: item.score,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
  const filtered = applyMinScoreFilter(mapped, resolveMinRecallScore());
  return rankRecallResults(filtered, query);
}

/**
 * A memory hit after the recall pipeline: raw cosine plus ranking signals.
 * `status` is omitted — archived memories are filtered before this point.
 */
/**
 * Shared recall pipeline (Fase 0 feedback): touch-boost recency, attach
 * importance + feedback, drop archived, rank by adjusted score.
 * Used by both cached and direct search so every recall path agrees.
 */
export async function rankRecallResults<
  T extends { id: string; memory: string; score?: number; created_at?: string; updated_at?: string },
>(results: T[], query: string): Promise<RankedMemory[]> {
  // Boost recently-accessed memories by using touch timestamp as virtual updated_at
  let boostedResults: T[] = results;
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

  // Fetch importance + feedback from memory-state (Qdrant payload authority,
  // Redis L2). Archived memories are dropped here — every recall path
  // excludes them. State rides free on mem0 metadata when present, so this
  // is usually zero extra round-trips. Never throws — degrades to defaults.
  type Enriched<U> = U & { importance: number | null; confidence: number; last_confirmed_at: string | null; status: FeedbackStatus; kind: FeedbackKind; title: string | null };
  let withSignals: Array<Enriched<T>> =
    boostedResults.map((r) => ({ ...r, importance: null, confidence: FEEDBACK_DEFAULTS.confidence, last_confirmed_at: null, status: 'active' as FeedbackStatus, kind: 'fact' as FeedbackKind, title: null }));
  try {
    const preloaded = new Map<string, unknown>();
    for (const r of boostedResults) {
      const meta = (r as { metadata?: unknown }).metadata;
      if (meta !== undefined) preloaded.set(r.id, meta);
    }
    const states = await getManyState(boostedResults.map((r) => r.id), preloaded);
    const maybe: Array<Enriched<T> | null> = boostedResults.map((r) => {
      const st = states.get(r.id);
      const feedback = st?.feedback ?? FEEDBACK_DEFAULTS;
      if (feedback.status === 'archived') return null;
      return {
        ...r,
        importance: st?.importance ?? null,
        confidence: feedback.confidence,
        last_confirmed_at: feedback.last_confirmed_at,
        status: feedback.status,
        kind: feedback.kind,
        title: feedback.title ?? null,
      };
    });
    withSignals = maybe.filter((r): r is Enriched<T> => r !== null);
  } catch {
    // Signal fetch failed — rank on raw scores with neutral defaults
  }

  const queryTerms = query.split(/\s+/).filter(t => t.length >= 3);
  return applyAgeDecayToResults(withSignals, queryTerms);
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
export async function cachedSearchMemory(query: string, project?: string, limit: number = 10): Promise<RankedMemory[]> {
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

  // Cache miss — full pipeline (touch-boost, signals, archived filter, rank)
  const withDecay = await searchMemory(query, project, limit);

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

// Authority: src/memory-state.ts (Qdrant payload, Redis L2). Re-exported
// here so existing import sites keep working.
export const IMPORTANCE_DEFAULT = STATE_IMPORTANCE_DEFAULT;

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
  if (!text) return IMPORTANCE_DEFAULT;
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

/**
 * Chat atoms carry extractor-owned importance/kind (persisted by
 * rememberChatTurn) — the regex heuristics must not run for them.
 * Exported so tests pin the contract without live backends or global mocks
 * (a spy-based test would need a second mock.module, which collides in one
 * bun process — see mem0-audit-trail.test.ts).
 */
export function shouldApplyHeuristicState(opts?: AddMemoryOpts): boolean {
  return !opts?.chatAtom;
}

/**
 * Heuristic post-save for non-chat paths: regex importance + state tag.
 * Exported for tests (live Qdrant, no LLM needed).
 */
export async function persistHeuristicState(text: string, memoryId: string): Promise<void> {
  const score = scoreImportance(text);
  await setMemoryImportance(memoryId, score);
  console.log(`[mem0] Importance scored: ${score.toFixed(2)} for ${memoryId.slice(0, 8)}…`);
  // Tag transient states at save time (fact is the neutral default).
  if (heuristicKind(text) === 'state') {
    await setMemoryFeedback(memoryId, { kind: 'state' });
  }
}

/**
 * Persist importance score for a memory ID.
 * Authority is Qdrant (memory-state.ts) — throws on write failure (fail-hard).
 */
export async function setMemoryImportance(memoryId: string, score: number): Promise<void> {
  await stateSetImportance(memoryId, score);
}

/**
 * Stored importance score for a memory ID.
 * Returns null if not yet scored, IMPORTANCE_DEFAULT when the backend is
 * unreachable. Never throws.
 */
export async function getMemoryImportance(memoryId: string): Promise<number | null> {
  return stateGetImportance(memoryId);
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

// ─── Memory Feedback (user votes: ✓ confirm / 🕐 archive) ───
// Fase 0 of per-memory quick actions (replaces like/dislike).
// Authority: src/memory-state.ts (Qdrant payload, Redis L2). Absent state =
// neutral defaults, so existing ranking behavior is unchanged until the
// first vote. Re-exported here so existing import sites keep working.

export const FEEDBACK_DEFAULTS: MemoryFeedback = STATE_FEEDBACK_DEFAULTS;

/** Display-title cap: 6 words ≈ 80 chars with margin. */
export const FEEDBACK_TITLE_MAX_CHARS = 80;

/** Stored feedback for a memory, or neutral defaults when never voted. Never throws. */
export async function getMemoryFeedback(memoryId: string): Promise<MemoryFeedback> {
  return stateGetFeedback(memoryId);
}

/**
 * Batch feedback fetch. Preloaded mem0 `metadata` is free — no I/O.
 * Missing keys → neutral defaults. Never throws.
 */
export async function getManyMemoryFeedback(
  ids: string[],
  preloadedById?: Map<string, unknown> | Record<string, unknown>,
): Promise<Map<string, MemoryFeedback>> {
  return stateGetManyFeedback(ids, preloadedById);
}

/**
 * Attach feedback signals to list-style items. Additive — safe for all
 * getMemories consumers (vault, sweeps, snapshots, restore).
 */
export async function attachFeedback<T extends { id: string }>(items: T[]): Promise<(T & MemoryFeedback)[]> {
  if (items.length === 0) return [];
  const preloaded = new Map<string, unknown>();
  for (const m of items) {
    const meta = (m as { metadata?: unknown }).metadata;
    if (meta !== undefined) preloaded.set(m.id, meta);
  }
  const map = await stateGetManyFeedback(items.map((m) => m.id), preloaded);
  return items.map((m) => ({ ...m, ...(map.get(m.id) ?? FEEDBACK_DEFAULTS) }));
}

/**
 * Remove a memory's feedback/importance (forget / trash / policy cleanup).
 * The Qdrant payload dies with the point; this evicts leftovers (L2) and is
 * idempotent. Swallows Not Found; throws on other Qdrant errors.
 */
export async function deleteState(memoryId: string): Promise<void> {
  await stateDeleteState(memoryId);
}

/**
 * Merge patch into stored feedback (creates with defaults when absent).
 * Fail-hard: throws when Qdrant cannot persist (the route surfaces 500).
 */
export async function setMemoryFeedback(
  memoryId: string,
  patch: Partial<MemoryFeedback>,
): Promise<MemoryFeedback> {
  return stateSetFeedback(memoryId, patch);
}

/**
 * Apply a user vote. Side effects per action:
 *   confirm   → confidence=1.0, last_confirmed_at=now, correct_count+1,
 *                touch (recency refresh) + importance floor 0.85 (180d half-life protection).
 *   archive   → status=archived (excluded from recall, kept in list/history).
 *   unarchive → status=active.
 * `forget` is NOT here — it deletes via trash+blocklist (issue #2).
 */
export async function applyMemoryFeedback(
  memoryId: string,
  action: FeedbackAction,
  opts?: { kind?: FeedbackKind },
): Promise<MemoryFeedback> {
  const now = new Date().toISOString();
  const kindPatch = opts?.kind ? { kind: opts.kind } : {};
  // Votes change ranking immediately — don't serve stale cached recalls.
  invalidateMem0Cache().catch(() => {});
  if (action === 'confirm') {
    const current = await getMemoryFeedback(memoryId);
    const next = await setMemoryFeedback(memoryId, {
      confidence: 1.0,
      last_confirmed_at: now,
      correct_count: current.correct_count + 1,
      ...kindPatch,
    });
    // Recency refresh is best-effort cache. The importance floor below is a
    // user-decision write (Qdrant authority) — fail-hard, like the vote above.
    await touchMemoryTimestamp(memoryId).catch(() => {});
    const importance = await getMemoryImportance(memoryId);
    await setMemoryImportance(memoryId, Math.max(importance ?? 0, 0.85));
    return next;
  }
  if (action === 'archive') {
    return setMemoryFeedback(memoryId, { status: 'archived', ...kindPatch });
  }
  return setMemoryFeedback(memoryId, { status: 'active', last_confirmed_at: now, ...kindPatch });
}

// ─── Forget Blocklist (✕ must not resurrect) ───
// Fase 0 of per-memory quick actions. `forget` hard-deletes AND records a
// hash of the text here; every save path checks it first (see addMemory).
// Without this, the next chat turn re-extracts the same fact.
// Authority: src/forget-blocklist.ts (workspace JSON file, Redis-free).
// Re-exported here so existing import sites keep working.
import {
  normalizeForBlocklist,
  blocklistHash,
  isBlocklisted,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklistPath,
  __setBlocklistPathForTests,
} from './forget-blocklist.js';
export { normalizeForBlocklist, blocklistHash, isBlocklisted, addToBlocklist, removeFromBlocklist, getBlocklistPath, __setBlocklistPathForTests };

// ─── Kind Heuristic (fact vs state) ───
// Fase 0: coarse text signals, no LLM. Errs toward `fact` (safe default —
// facts decay slowly). Only `state` is ever persisted here; `fact` is the
// neutral default and needs no key.

const STATE_HINTS = [
  /\b(hoje|agora|ainda|ontem|no momento|atualmente|essa semana|ultimamente|por enquanto)\b/i,
  /\b\d{1,2}[h:]\d{2}\b/, // time of day ("14h30", "às 8:00")
  /\b(estou|esta|está|to|tô|tá|continuo|sigo)\s+\w*(ando|endo|indo)\b/i, // progressive ("estou lendo")
  /\b(lendo|tomando|usando|sentindo|fazendo|trabalhando|estudando|jogando|assistindo|vendo|ouvindo|comendo|bebendo|dormindo|acordando|saindo|voltando|passando)\b/i,
  /\b(estou|está|esta|to|tô|ta|tá)\s+(com|me sentindo|sentindo)\b/i, // state report ("estou com dor")
];

/** Classify saved text as stable fact vs transient state. Pure, unit-tested. */
export function heuristicKind(text: string): FeedbackKind {
  return STATE_HINTS.some((re) => re.test(text)) ? 'state' : 'fact';
}

// ─── Memory Cleanup (memoryScan) ───
// Fase 4: automatic deletions go through the shared domain policy
// (archive to trash + audit). The trash scope itself is never scanned.

/**
 * Shared domain policy for AUTOMATIC deletions (Fase 4).
 * Snapshot → trash copy with provenance → hard delete → audit record.
 * Per-item failures are collected in the report, never thrown.
 */
export async function deleteMemoriesWithPolicy(input: {
  ids: string[];
  project?: string;
  reason: string;
  trigger: string;
  replacedById?: string;
}): Promise<{
  archived: string[];
  trashIds: Record<string, string | null>;
  failed: { id: string; error: string }[];
  audit: PolicyAuditRecord[];
  auditFailed: { memoryId: string; error: string }[];
}> {
  if (input.project === TRASH_PROJECT) {
    return {
      archived: [],
      trashIds: {},
      failed: input.ids.map(id => ({ id, error: 'refusing to archive the trash scope itself' })),
      audit: [],
      auditFailed: [],
    };
  }
  const { applyDeletionPolicy } = await import('./memory-policy.js');
  const { logMaintenance } = await import('./maintenance-log.js');
  const report = await applyDeletionPolicy(
    { ...input, op: 'archive' },
    {
      snapshot: ids => snapshotMemories(ids, input.project),
      trashAndDelete: (snap, fromProject, provenance) => trashAndDelete(snap, fromProject, provenance),
      audit: record => logMaintenance('memory_policy_delete', { ...record }),
    }
  );
  try {
    await invalidateMem0Cache(input.project);
  } catch { /* non-critical */ }
  return { archived: report.archived, trashIds: report.trashIds, failed: report.failed, audit: report.audit, auditFailed: report.auditFailed };
}

/**
 * Scan project memories and archive those that are cold AND low quality.
 * Safety rules:
 *   - Only archives project-scoped memories (global memories are permanent)
 *   - Refuses the trash scope itself
 *   - Only archives memories > 90 days old (3x the cold threshold — extra safety margin)
 *   - Only archives memories with quality score < 3 (low-value content)
 *   - Archived items land in the trash scope with provenance + audit trail
 *   - Returns a report of what was archived
 */
export async function scanAndCleanProjectMemories(project: string): Promise<{
  total: number;
  deleted: number;
  deletedItems: { id: string; memory: string; daysOld: number }[];
}> {
  const memories = await getMemories(project, 200);

  // Collect hygiene candidates first; the policy archives them as one batch.
  const candidates = new Map<string, { memory: string; daysOld: number; quality: number }>();
  for (const mem of memories) {
    const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : null;
    if (!createdMs || isNaN(createdMs)) continue;
    const daysOld = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    if (daysOld < 90) continue; // extra safety margin — only 90+ days
    const quality = scoreMemoryQuality(mem.memory);
    if (quality >= 3) continue; // keep quality memories even if old
    candidates.set(mem.id, { memory: mem.memory.slice(0, 80), daysOld: Math.round(daysOld), quality });
  }

  const deletedItems: { id: string; memory: string; daysOld: number }[] = [];
  if (candidates.size > 0) {
    const report = await deleteMemoriesWithPolicy({
      ids: [...candidates.keys()],
      project,
      reason: 'stale low-quality memory (90+ days old, quality < 3)',
      trigger: 'memory_scan',
    });
    for (const id of report.archived) {
      const c = candidates.get(id);
      if (c) deletedItems.push({ id, memory: c.memory, daysOld: c.daysOld });
    }
    for (const f of report.failed) {
      console.error(`[mem0] memory_scan failed to archive ${f.id}: ${f.error}`);
    }
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

export async function getMemories(project?: string, limit: number = 20): Promise<Array<{ id: string; memory: string; created_at?: string; updated_at?: string; metadata?: Record<string, unknown> } & MemoryFeedback>> {
  const m = getClient();
  const result = await m.getAll({
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve created_at/updated_at from Mem0 response
  const mapped = (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
  // Fase 0: feedback signals ride along for vault badges (single pipeline round-trip)
  return attachFeedback(mapped);
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const m = getClient();
  await m.delete(memoryId);
  invalidateMem0Cache().catch(() => {});
  // Fase 3: prune derived projection (best-effort, never fails the delete).
  try {
    await graphrag.removeGraphProvenance(memoryId);
  } catch (err) {
    console.error('[mem0] graph provenance prune failed:', err instanceof Error ? err.message : err);
  }
}

// ─── Delete audit trail (snapshot-before-delete + trash) ───

/** Mem0 project scope holding deleted memories. Invisible to recall sweeps
 * (reaper/dedup/consolidation only scan workspace projects + global scope). */
export const TRASH_PROJECT = 'trash';

/** Fetch full texts for ids BEFORE deleting. Never throws — returns
 * `{id, missing:true}` entries for anything unfetchable. */
export async function snapshotMemories(ids: string[], project?: string, limit = 100): Promise<MemorySnapshot[]> {
  try {
    const all = await getMemories(project, limit);
    const byId = new Map(all.map(m => [m.id, m]));
    return ids.map(id => {
      const found = byId.get(id);
      if (!found) return { id, memory: '', missing: true as const };
      return { id, memory: found.memory ?? '', ...(found.created_at ? { created_at: found.created_at } : {}) };
    });
  } catch (err) {
    console.error('[mem0] snapshotMemories failed:', err instanceof Error ? err.message : err);
    return ids.map(id => ({ id, memory: '', missing: true as const }));
  }
}

/**
 * Copy a memory to the trash scope (with provenance metadata), then hard-delete
 * the original. Trash copies skip quality/conflict checks and graph ingestion.
 * FAIL-CLOSED: the original is deleted ONLY after the trash copy is confirmed.
 * If the copy fails (or the snapshot is missing/empty), the original is
 * preserved and the caller gets `{ trashId: null, deleted: false }` so the
 * item can be retried — an "archive" never becomes silent data loss.
 */
export async function trashAndDelete(
  snapshot: MemorySnapshot,
  fromProject: string | undefined,
  provenance: TrashProvenance,
): Promise<{ trashId: string | null; deleted: boolean }> {
  if (!snapshot.missing && snapshot.memory) {
    // Snapshot user state BEFORE deleting — the Qdrant payload (and its
    // lain_feedback/lain_importance) dies with the point. Stashed in the
    // trash copy's metadata so restoreFromTrash can reapply it in full.
    // Reads never throw; default state is simply not snapshotted.
    let stateSnapshot: { feedback: MemoryFeedback; importance: number | null } | null = null;
    try {
      const cur = (await getManyState([snapshot.id])).get(snapshot.id);
      if (cur && !isDefaultState(cur.feedback, cur.importance)) {
        stateSnapshot = { feedback: cur.feedback, importance: cur.importance };
      }
    } catch { /* defensive — the trash copy still proceeds */ }
    let trashId: string | null = null;
    try {
      const saved = await addMemory(snapshot.memory, TRASH_PROJECT, {
        inferFalse: true, // archive must be byte-identical (no LLM decomposition that can return empty)
        skipQualityCheck: true,
        skipConflictCheck: true,
        skipGraphIngest: true,
        skipBlocklistCheck: true, // trash carries forgotten text by design — see blocklist section
        metadata: {
          original_id: snapshot.id,
          deleted_from: fromProject ?? 'global',
          original_created_at: snapshot.created_at ?? null,
          reason: provenance.reason,
          trigger: provenance.trigger,
          ...(provenance.replacedById ? { replaced_by: provenance.replacedById } : {}),
          ...(stateSnapshot ? { [STATE_SNAPSHOT_KEY]: stateSnapshot } : {}),
          trashed_at: new Date().toISOString(),
        },
      });
      trashId = saved[0]?.id ?? null;
    } catch (err) {
      console.error(`[mem0] trash copy failed for ${snapshot.id} — original preserved:`, err instanceof Error ? err.message : err);
      return { trashId: null, deleted: false };
    }
    if (!trashId) {
      console.error(`[mem0] trash copy unconfirmed for ${snapshot.id} — original preserved`);
      return { trashId: null, deleted: false };
    }
    await deleteMemory(snapshot.id);
    // The point (and its payload state) is gone; evict leftovers (L2).
    // Best-effort: cleanup must not fail an otherwise complete archive.
    await stateDeleteState(snapshot.id).catch((err) =>
      console.error(`[mem0] post-delete state cleanup failed for ${snapshot.id}:`, err instanceof Error ? err.message : err));
    return { trashId, deleted: true };
  }
  console.error(`[mem0] refusing to delete ${snapshot.id} without a trash copy (missing/empty snapshot) — preserved`);
  return { trashId: null, deleted: false };
}

/** Undo window for ✕ (forget). Trash copies older than this cannot be restored. */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Undo a forget: re-save the trash copy into its original scope, delete the
 * trash copy, and lift the blocklist entry. FAIL-CLOSED: the trash copy is
 * deleted only after the re-save is confirmed.
 */
export async function restoreFromTrash(trashId: string): Promise<RestoreResult> {
  let found;
  try {
    const all = await getMemories(TRASH_PROJECT, 500);
    found = all.find(m => m.id === trashId);
  } catch (err) {
    console.error('[mem0] restore failed (trash unreadable):', err instanceof Error ? err.message : err);
    return { id: null, restored: false, reason: 'trash unreadable' };
  }
  if (!found?.memory) return { id: null, restored: false, reason: 'not found in trash' };
  const meta = (found.metadata ?? {}) as Record<string, unknown>;
  const trashedAt = typeof meta.trashed_at === 'string' ? Date.parse(meta.trashed_at) : NaN;
  if (!Number.isNaN(trashedAt) && Date.now() - trashedAt > RESTORE_WINDOW_MS) {
    return { id: null, restored: false, reason: 'restore window expired (7d)' };
  }
  const fromProject = typeof meta.deleted_from === 'string' && meta.deleted_from !== 'global'
    ? meta.deleted_from
    : undefined;
  const originalId = typeof meta.original_id === 'string' ? meta.original_id : undefined;
  let savedId: string | null = null;
  try {
    const saved = await addMemory(found.memory, fromProject, {
      inferFalse: true,
      skipQualityCheck: true,
      skipConflictCheck: true,
      skipBlocklistCheck: true, // restoring a forget — text is blocklisted until lifted below
    });
    savedId = saved[0]?.id ?? null;
  } catch (err) {
    console.error(`[mem0] restore re-save failed for ${trashId} — trash preserved:`, err instanceof Error ? err.message : err);
    return { id: null, restored: false, reason: 're-save failed' };
  }
  if (!savedId) {
    console.error(`[mem0] restore re-save unconfirmed for ${trashId} — trash preserved`);
    return { id: null, restored: false, reason: 're-save unconfirmed' };
  }
  // Reapply the state snapshot stashed in the trash copy (full fidelity:
  // confidence, correct_count, title, importance...). Trash copies written
  // before snapshots fall back to the old kind-only preservation.
  const stateSnapshot = parseStateSnapshot(meta[STATE_SNAPSHOT_KEY]);
  if (stateSnapshot) {
    try {
      await setMemoryFeedback(savedId, stateSnapshot.feedback);
      if (stateSnapshot.importance !== null) await setMemoryImportance(savedId, stateSnapshot.importance);
    } catch (err) {
      console.error(`[mem0] restore state re-apply failed for ${trashId} — trash preserved:`, err instanceof Error ? err.message : err);
      return { id: savedId, restored: false, reason: 'state restore failed' };
    }
  } else if (originalId) {
    // Preserve an explicit `state` vote from before the forget (the auto
    // heuristic may not re-fire on the restored text).
    try {
      const originalFeedback = await getMemoryFeedback(originalId);
      if (originalFeedback.kind === 'state') {
        await setMemoryFeedback(savedId, { kind: 'state' });
      }
    } catch { /* keep heuristic kind */ }
  }
  await deleteMemory(trashId);
  // Evict the trash copy's leftovers (L2). Best-effort.
  await stateDeleteState(trashId).catch((err) =>
    console.error(`[mem0] post-restore state cleanup failed for ${trashId}:`, err instanceof Error ? err.message : err));
  await removeFromBlocklist(found.memory);
  return { id: savedId, restored: true };
}

// C3: Update an existing memory by ID. Uses Mem0 SDK native update.
// OSS Memory.update(id, string) takes a plain string and returns { message: string }.
// ID is preserved (in-place update). No conflict check — caller asserts intentional replacement.
export async function updateMemory(memoryId: string, newText: string, project?: string): Promise<{ id: string; memory: string }> {
  const m = getClient();
  await m.update(memoryId, newText);
  invalidateMem0Cache(project).catch(() => {});
  // Fase 3: re-derive projection — drop edges sourced only by the old content,
  // then re-ingest the new text with the same memory ID as provenance.
  try {
    await graphrag.removeGraphProvenance(memoryId);
    graphrag.queueGraphIngest(newText, project, [memoryId]);
  } catch (err) {
    console.error('[mem0] graph re-ingest after update failed:', err instanceof Error ? err.message : err);
  }
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
 * Groups related memories, merges them via the fast LLM, replaces fragments.
 * Returns { consolidated, deleted, groups }.
 */
/**
 * LLM-merge a set of fragment texts into one memory.
 * Same prompt + retry as the group path in consolidateMemories.
 * Returns null when the LLM returns nothing usable.
 */
async function llmMergeMemoryTexts(texts: string[]): Promise<string | null> {
  const { runFastLlmJson } = await import('./llm-client.js');
  const fragments = texts.join('\n- ');
  const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
    `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
  ));
  if (result?.consolidated && result.consolidated.length > 20) return result.consolidated;
  return null;
}

/**
 * Item 2 gate: pending-queue merges only run when explicitly enabled.
 * Sweep queues (item 1) and contradiction visibility (item 3) work regardless —
 * this way the queue can be observed before auto-merge is switched on.
 */
export function isPendingMergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LAIN_PENDING_MERGE_ENABLED ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Consume the pending-review merge queue (UPDATE verdicts from the
 * contradiction sweep) before lexical grouping. Exact LLM-detected pairs —
 * no keyword guessing. Same trash + audit safety as the group path.
 */
async function consolidatePendingMerges(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  details: ConsolidationDetail[];
}> {
  const { claimPendingMerges, updateEntry, maxAttemptsReached } = await import('./pending-review.js');
  const { logMaintenance } = await import('./maintenance-log.js');
  const claimed = await claimPendingMerges(project, 5);
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  for (const entry of claimed) {
    try {
      const texts = [entry.memory, ...entry.related.map(r => r.memory)].filter(t => t && t.trim());
      if (texts.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      const merged = await llmMergeMemoryTexts(texts);
      if (!merged || scoreMemoryQuality(merged) < MIN_MEMORY_QUALITY) {
        const terminal = maxAttemptsReached(entry);
        await updateEntry(entry.id, {
          status: terminal ? 'failed' : 'pending',
          result: { error: 'merge rejected by quality gate or empty' },
        });
        console.log(`[mem0] Pending merge ${entry.id.slice(0, 8)} rejected by quality gate${terminal ? ' (terminal)' : ', will retry'}`);
        continue;
      }
      const ids = [entry.memoryId, ...entry.related.map(r => r.id)].filter(id => id && id !== 'pending');
      const doomed = await snapshotMemories(ids, project);
      const existing = doomed.filter(s => !s.missing && s.memory);
      if (existing.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      // Verbatim save (inferFalse): the merged text is already final. With
      // inference on, Mem0 can decompose it into an UPDATE against the still-
      // present fragments and return no id ("unknown") — then the fragments
      // below would be deleted with nothing saved (net loss). Same rationale
      // as the trash path (byte-identical archive).
      const saved = await addMemory(merged, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
      const newId = saved[0]?.id;
      if (!newId || newId === 'unknown' || newId === 'rejected') {
        console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} save unconfirmed — fragments preserved`);
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: 'consolidated save unconfirmed, fragments preserved' },
        });
        continue;
      }
      consolidated++;

      const trashIds: Record<string, string | null> = {};
      for (const snap of doomed) {
        try {
          const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
            reason: 'merged from pending review queue',
            trigger: 'consolidation:pending_queue',
            replacedById: newId,
          });
          trashIds[snap.id] = trashId;
          if (fragDeleted) {
            deleted++;
          } else {
            console.error(`[mem0] Pending merge deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
          }
        } catch {}
      }

      await updateEntry(entry.id, { status: 'done', result: { mergedId: newId } });
      logMaintenance('pending_merge_done', {
        entry_id: entry.id,
        scope: project ?? 'global',
        new_id: newId,
        fragments: existing.length,
      });
      details.push({
        fragments: texts.map(f => f.slice(0, 120)),
        result: merged.slice(0, 200),
        fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
        resultFull: merged,
        newId,
      });
    } catch (err) {
      try {
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: err instanceof Error ? err.message : String(err) },
        });
      } catch {}
      console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { consolidated, deleted, details };
}

export async function consolidateMemories(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  groups: number;
  details: ConsolidationDetail[];
}> {
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  // Item 1: exact LLM-detected UPDATE pairs first — no lexical guessing.
  // Gated by LAIN_PENDING_MERGE_ENABLED (item 2): when off, the queue only
  // accumulates for observation via /api/memory/contradictions.
  if (isPendingMergeEnabled()) {
    try {
      const queued = await consolidatePendingMerges(project);
      consolidated += queued.consolidated;
      deleted += queued.deleted;
      details.push(...queued.details);
    } catch (err) {
      console.error('[mem0] Pending-queue consolidation failed:', err instanceof Error ? err.message : err);
    }
  }

  const allMems = await getMemories(project, 100);
  if (allMems.length < 4) return { consolidated, deleted, groups: 0, details };

  const groups = groupMemories(allMems);
  if (groups.size === 0) return { consolidated, deleted, groups: 0, details };

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
        // Snapshot fragments BEFORE replacing — full texts for the audit trail.
        const doomed = await snapshotMemories(group.map(m => m.id).filter(id => id && id !== 'pending'), project);
        // Verbatim save (inferFalse): the consolidated text is already final.
        // With inference on, Mem0 can decompose it into an UPDATE against the
        // still-present fragments and return no id ("unknown") — then the
        // fragments below would be deleted with nothing saved (net loss).
        const saved = await addMemory(result.consolidated, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
        const newId = saved[0]?.id;
        if (!newId || newId === 'unknown' || newId === 'rejected') {
          console.error(`[mem0] Consolidation save unconfirmed — fragments preserved`);
          continue;
        }
        consolidated++;

        const trashIds: Record<string, string | null> = {};
        // Delete fragments (via trash — fail-closed: unconfirmed copies are preserved, not counted)
        for (const snap of doomed) {
          try {
            const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
              reason: 'merged into consolidated memory',
              trigger: 'consolidation',
              replacedById: newId,
            });
            trashIds[snap.id] = trashId;
            if (fragDeleted) {
              deleted++;
            } else {
              console.error(`[mem0] Consolidation deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
            }
          } catch {}
        }

        details.push({
          fragments: fragmentTexts.map(f => f.slice(0, 120)),
          result: result.consolidated.slice(0, 200),
          fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
          resultFull: result.consolidated,
          newId,
        });
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

const BACKFILL_PROJECTS = [undefined] as const;

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
        try {
          await setMemoryImportance(mem.id, score);
        } catch (err) {
          // Maintenance must not die on one bad point — retry next tick.
          console.error(`[mem0] backfillImportance failed for ${mem.id}:`, err instanceof Error ? err.message : err);
          continue;
        }
        totalScored++;
      }
    } catch { /* non-critical — skip project */ }
  }

  return totalScored;
}

// ─── Automatic Memory Maintenance ───

// ─── Rotating contradiction sweep (paraphrase hygiene) ───
// Replaces the old "always the 20 most recent globals" window with a
// round-robin cursor: each tick processes the next slice of one scope
// (global, then each project), persisting progress in Redis.

export function getContradictionFetchLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_FETCH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 200 : Math.min(n, 500);
}

export function getContradictionSliceSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_SLICE;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 20 : Math.min(n, 100);
}

export function getContradictionMaxLlm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_MAX_LLM;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 10 : Math.min(n, 100);
}

/** Pure wrap-around slice: returns `size` indices starting at `cursor` (mod total). */
export function nextSliceIndices(total: number, cursor: number, size: number): number[] {
  if (total <= 0 || size <= 0) return [];
  const start = ((Math.floor(cursor) % total) + total) % total;
  const out: number[] = [];
  for (let k = 0; k < Math.min(size, total); k++) out.push((start + k) % total);
  return out;
}

const contradictionCursorFallback = new Map<string, number>();
let contradictionScopeIdxFallback = 0;

function contradictionScopeKey(scope: string | undefined): string {
  return scope ?? 'global';
}

export async function getContradictionCursor(scope: string | undefined): Promise<number> {
  const key = `mem0:contradiction_cursor:${contradictionScopeKey(scope)}`;
  if (isRedisAvailable()) {
    try {
      const raw = await getRedis().get(key);
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isNaN(n) || n < 0 ? 0 : n;
    } catch { /* fall through to fallback */ }
  }
  return contradictionCursorFallback.get(contradictionScopeKey(scope)) ?? 0;
}

export async function setContradictionCursor(scope: string | undefined, cursor: number): Promise<void> {
  const safe = Math.max(0, Math.floor(cursor));
  contradictionCursorFallback.set(contradictionScopeKey(scope), safe);
  if (isRedisAvailable()) {
    try {
      await getRedis().set(`mem0:contradiction_cursor:${contradictionScopeKey(scope)}`, String(safe));
    } catch { /* non-critical */ }
  }
}

async function getContradictionScopeIdx(mod: number): Promise<number> {
  if (mod <= 0) return 0;
  if (isRedisAvailable()) {
    try {
      const raw = await getRedis().get('mem0:contradiction_scope_idx');
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isNaN(n) || n < 0 ? 0 : n % mod;
    } catch { /* fall through */ }
  }
  return contradictionScopeIdxFallback % mod;
}

async function setContradictionScopeIdx(idx: number): Promise<void> {
  contradictionScopeIdxFallback = Math.max(0, Math.floor(idx));
  if (isRedisAvailable()) {
    try {
      await getRedis().set('mem0:contradiction_scope_idx', String(contradictionScopeIdxFallback));
    } catch { /* non-critical */ }
  }
}

/** Process one slice of one scope. Never throws on per-memory errors. */
export async function runContradictionSweepForScope(
  scope: string | undefined,
  opts?: { fetchLimit?: number; sliceSize?: number; maxLlm?: number; cursor?: number },
): Promise<ContradictionSweepReport> {
  const fetchLimit = opts?.fetchLimit ?? getContradictionFetchLimit();
  const sliceSize = opts?.sliceSize ?? getContradictionSliceSize();
  const maxLlm = opts?.maxLlm ?? getContradictionMaxLlm();
  const memories = await getMemories(scope, fetchLimit);
  const total = memories.length;
  if (total === 0) {
    return { scope, total: 0, checked: 0, removed: 0, llmCalls: 0, nextCursor: 0, queuedMerges: 0, queuedContradictions: 0 };
  }

  const cursor = opts?.cursor ?? await getContradictionCursor(scope);
  const indices = nextSliceIndices(total, cursor, sliceSize);
  const slice = indices.map(i => memories[i]);

  const { classifyMemoryAction } = await import('./contradiction-detector.js');
  const { logMaintenance } = await import('./maintenance-log.js');
  const { enqueueVerdict } = await import('./pending-review.js');
  let removed = 0;
  let llmCalls = 0;
  let queuedMerges = 0;
  let queuedContradictions = 0;
  const queuedMergeIds: string[] = [];
  const queuedContradictionIds: string[] = [];

  for (const mem of slice) {
    const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : Date.now();
    if (Date.now() - createdMs < 60 * 60 * 1000) continue;

    let others: { id: string; memory: string; score: number }[] = [];
    try {
      const similar = await searchMemory(mem.memory, scope, 5);
      others = similar
        .filter(s => s.id !== mem.id && (s.score ?? 0) > 0.6)
        .map(s => ({ id: s.id, memory: s.memory, score: s.score ?? 0 }));
    } catch {
      continue;
    }
    if (others.length === 0) continue;
    if (llmCalls >= maxLlm) break;

    let classification;
    try {
      classification = await classifyMemoryAction(mem.memory, others);
    } catch {
      continue;
    }
    llmCalls++;

    if (classification.action === 'NOOP' && classification.supersedes.length === 0) {
      try {
        const report = await deleteMemoriesWithPolicy({
          ids: [mem.id],
          project: scope,
          reason: classification.reason,
          trigger: 'maintenance:contradiction_scan',
        });
        if (report.archived.includes(mem.id)) {
          removed++;
          console.log(`[mem0] Maintenance: archived duplicate ${mem.id} (trash: ${report.trashIds[mem.id] ?? 'copy-failed'})`);
          logMaintenance('memory_duplicate_purge', {
            trigger: 'maintenance:contradiction_scan',
            reason: classification.reason,
            deleted: [{ id: mem.id, memory: mem.memory, created_at: mem.created_at ?? null, trash_id: report.trashIds[mem.id] ?? null }],
          });
        }
      } catch { /* per-memory failure never fails the sweep */ }
    } else if (classification.action === 'UPDATE' || classification.action === 'DELETE') {
      // Item 1+3: verdicts the auto-flow must not action alone go to the
      // pending-review queue instead of being dropped. UPDATE → merge
      // candidates for consolidation; DELETE → contradictions for a human.
      try {
        const kind = classification.action === 'UPDATE' ? 'merge' as const : 'contradiction' as const;
        const { entry, duplicate } = await enqueueVerdict({
          kind,
          verdict: classification.action,
          scope,
          memoryId: mem.id,
          memory: mem.memory,
          related: others.map(o => ({ id: o.id, memory: o.memory })),
          reason: classification.reason,
        });
        if (!duplicate) {
          if (kind === 'merge') {
            queuedMerges++;
            queuedMergeIds.push(entry.id);
          } else {
            queuedContradictions++;
            queuedContradictionIds.push(entry.id);
          }
          logMaintenance('pending_review_queued', {
            kind,
            scope: scope ?? 'global',
            memory_id: mem.id,
            entry_id: entry.id,
            reason: classification.reason,
          });
        }
      } catch { /* queue failure never fails the sweep */ }
    }
  }

  const nextCursor = total > 0 ? ((((Math.floor(cursor) % total) + total) % total) + slice.length) % total : 0;
  await setContradictionCursor(scope, nextCursor);
  return { scope, total, checked: slice.length, removed, llmCalls, nextCursor, queuedMerges, queuedContradictions };
}

/** Round-robin over [global, ...projects]: one scope per maintenance tick. */
export async function runRotatingContradictionSweep(): Promise<ContradictionSweepReport> {
  let scopes: (string | undefined)[] = [undefined];
  try {
    for (const p of listProjects()) scopes.push(p.name);
  } catch { /* projects unavailable — global only */ }
  const idx = await getContradictionScopeIdx(scopes.length);
  const scope = scopes[idx % scopes.length];
  const report = await runContradictionSweepForScope(scope);
  await setContradictionScopeIdx((idx + 1) % scopes.length);
  return report;
}

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

      // ── Graph reconcile (Fase 3): drain outbox, heal derived projection ──
      try {
        const { reconcileGraph } = await import('./graphrag.js');
        const reconciled = await reconcileGraph();
        if (reconciled.processed > 0 || reconciled.failed > 0) {
          console.log(`[graphrag] Maintenance reconcile: ${reconciled.processed} processed, ${reconciled.failed} failed, ${reconciled.pending} pending`);
        }
      } catch (err) {
        console.error('[graphrag] Maintenance reconcile error:', err);
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

      // ── Periodic contradiction scan: rotating slice (1 scope/tick, cursor-persisted) ──
      try {
        const sweepStart = Date.now();
        const sweep = await runRotatingContradictionSweep();
        const sweepDuration = Date.now() - sweepStart;
        if (sweep.removed > 0 || sweep.checked > 0) {
          logMaintenance('contradiction_scan', {
            scope: sweep.scope ?? 'global',
            total: sweep.total,
            checked: sweep.checked,
            removed: sweep.removed,
            llmCalls: sweep.llmCalls,
            nextCursor: sweep.nextCursor,
            queuedMerges: sweep.queuedMerges,
            queuedContradictions: sweep.queuedContradictions,
          }, sweepDuration);
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
