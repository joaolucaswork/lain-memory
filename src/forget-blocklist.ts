/**
 * Forget blocklist — hashes of user-forgotten texts that must never be
 * re-extracted (issue #9).
 *
 * Used to live ONLY in Redis (`mem0:forget-blocklist` set): flushing Redis
 * resurrected forgotten memories on the next save. Now the authority is a
 * plain JSON file under the workspace:
 *
 *   $LAIN_WORKSPACE_DIR/.knowledge/forget-blocklist.json  (["sha256...", ...])
 *
 * Writes are atomic (temp file + rename) and serialized per-file
 * (withFileLock). Reads distinguish "file missing" (fresh install → empty
 * set) from "file unreadable/corrupt" (fail-closed → treat as all-blocked).
 *
 * Reads never throw. Writes throw on failure (fail-hard — a forget that
 * cannot record its blocklist entry must surface, not silently resurrect).
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock, safeWriteFileSync } from './file-io-lock.js';
import { KNOWLEDGE_DIR } from './workspace.js';

export const FORGET_BLOCKLIST_FILENAME = 'forget-blocklist.json';

/** Test override (see __setBlocklistPathForTests). Null = production path. */
let _pathOverride: string | null = null;

/** Production path. Tests swap it via __setBlocklistPathForTests + restore. */
export function getBlocklistPath(): string {
  return _pathOverride ?? join(KNOWLEDGE_DIR, FORGET_BLOCKLIST_FILENAME);
}

/** Test-only: redirect the blocklist file (pass null to restore). */
export function __setBlocklistPathForTests(p: string | null): void {
  _pathOverride = p;
}

/**
 * Canonical form for blocklist matching: lowercase, no accents, no
 * punctuation, single spaces. Paraphrases still pass — exact and
 * near-exact repeats are caught, which is the re-extraction case.
 */
export function normalizeForBlocklist(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function blocklistHash(text: string): string {
  return createHash('sha256').update(normalizeForBlocklist(text)).digest('hex');
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Read + parse inside a lock (writers) or standalone (readers). Throws on corrupt/unreadable. */
function loadFromDisk(file: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) return new Set(); // fresh install — nothing forgotten yet
    throw err;
  }
  if (!raw.trim()) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`forget-blocklist corrupt (invalid JSON): ${file}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((h) => typeof h === 'string')) {
    throw new Error(`forget-blocklist corrupt (expected string array): ${file}`);
  }
  return new Set(parsed as string[]);
}

function saveToDisk(file: string, hashes: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true });
  safeWriteFileSync(file, JSON.stringify([...hashes].sort()));
}

/**
 * True when the text (or a near-exact repeat) was forgotten.
 * Fail-closed: on any read error (corrupt file, permissions) logs and
 * returns true — a forgotten memory must not resurrect because of an I/O
 * error. Only blank text and a confirmed-missing entry return false.
 */
export async function isBlocklisted(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  try {
    return loadFromDisk(getBlocklistPath()).has(blocklistHash(text));
  } catch (err) {
    console.error('[blocklist] read failed — failing closed (blocked):', err instanceof Error ? err.message : err);
    return true;
  }
}

/** Record a forgotten text hash. Throws on write failure. No-op for blank text. */
export async function addToBlocklist(text: string): Promise<void> {
  if (!text.trim()) return;
  const hash = blocklistHash(text);
  const file = getBlocklistPath();
  await withFileLock(file, () => {
    const hashes = loadFromDisk(file);
    if (hashes.has(hash)) return;
    hashes.add(hash);
    saveToDisk(file, hashes);
  });
}

/** Lift a blocklist entry (restore flow). Throws on write failure. */
export async function removeFromBlocklist(text: string): Promise<void> {
  if (!text.trim()) return;
  const hash = blocklistHash(text);
  const file = getBlocklistPath();
  await withFileLock(file, () => {
    const hashes = loadFromDisk(file);
    if (!hashes.has(hash)) return;
    hashes.delete(hash);
    saveToDisk(file, hashes);
  });
}
