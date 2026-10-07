import { describe, it, expect } from 'bun:test';
import { shouldEnrichTechnicalMemory, acceptEnrichedMemory } from './mem0.js';

// Regression for the verified incident: a git-hook security note saved via
// mode:raw came back with a fabricated `POST /git/commit` + auth header +
// curl, because pre-save Haiku enrichment ran before Mem0 and the prompt
// literally demanded a URL/method/curl.

const INCIDENT_NOTE =
  'Lain git-approval gate had a bypass: `git -C <path> commit --no-verify` ' +
  'produced an unapproved commit. Fixed in commit 5f4ec5e by rewriting ' +
  'detectOpKind as a flag-tolerant tokenizer and making the commit branch ' +
  'fail closed. op-regex.ts and pretool.ts changed.';

describe('shouldEnrichTechnicalMemory', () => {
  it('NEVER enriches a verbatim (inferFalse / mode:raw) save', () => {
    // Even an API-shaped, low-actionability memory is untouched in raw mode.
    expect(
      shouldEnrichTechnicalMemory('GET /v1/users returns the profile', {
        inferFalse: true,
      })
    ).toBe(false);
  });

  it('does not enrich when the caller opted out of quality scoring', () => {
    expect(
      shouldEnrichTechnicalMemory('GET /v1/users returns the profile', {
        skipQualityCheck: true,
      })
    ).toBe(false);
  });

  it('INCIDENT: a technical note that is not API-shaped is never enriched', () => {
    // The reported bug: this would have been Haiku-rewritten into a fake
    // `POST /git/commit` curl. Now it is left exactly as-is.
    expect(shouldEnrichTechnicalMemory(INCIDENT_NOTE)).toBe(false);
    expect(shouldEnrichTechnicalMemory(INCIDENT_NOTE, { inferFalse: true })).toBe(false);
  });

  it('does not enrich non-technical prose', () => {
    expect(
      shouldEnrichTechnicalMemory('User prefers concise replies and dark mode')
    ).toBe(false);
  });

  it('does not enrich an already-actionable API memory (score > 2)', () => {
    const complete =
      'POST https://api.example.com/v1/login with header ' +
      "Authorization: Bearer TOKEN — curl https://api.example.com/v1/login";
    expect(shouldEnrichTechnicalMemory(complete)).toBe(false);
  });

  it('enriches ONLY an API-shaped, low-actionability technical memory', () => {
    // Technical + HTTP method present (API-shaped) + low actionability
    // (no full URL, no auth, no curl) → the one legitimate case.
    expect(
      shouldEnrichTechnicalMemory('The user profile endpoint is GET /v1/users')
    ).toBe(true);
  });
});

describe('acceptEnrichedMemory', () => {
  const original = 'The user profile endpoint is GET /v1/users';

  it('rejects an empty rewrite', () => {
    expect(acceptEnrichedMemory(original, '')).toBe(false);
  });

  it('rejects a rewrite that dropped/altered the original', () => {
    expect(
      acceptEnrichedMemory(original, 'Completely unrelated fabricated content')
    ).toBe(false);
  });

  it('rejects a longer rewrite that added NO real actionability (no length bias)', () => {
    const padded = original + ' This endpoint is also documented internally.';
    expect(padded.length).toBeGreaterThan(original.length);
    expect(acceptEnrichedMemory(original, padded)).toBe(false);
  });

  it('INCIDENT: rejects a rewrite that introduced a fabricated URL/host', () => {
    // Original is API-shaped (method) but has NO URL. The rewrite preserves
    // it and even raises the actionability score — but invents a host. The
    // deterministic anti-fabrication guard must reject regardless of score.
    const fabricated =
      original +
      "\ncurl https://api.yourservice.com/v1/users -H 'Authorization: Bearer X'";
    expect(acceptEnrichedMemory(original, fabricated)).toBe(false);
  });

  it('accepts a rewrite that preserved the original, reused its OWN URL, and raised actionability', () => {
    const apiOriginal =
      'The user profile endpoint is GET https://api.example.com/v1/users';
    const enriched =
      apiOriginal +
      '\nFull example: curl https://api.example.com/v1/users ' +
      "-H 'Authorization: Bearer TOKEN'";
    expect(acceptEnrichedMemory(apiOriginal, enriched)).toBe(true);
  });
});
