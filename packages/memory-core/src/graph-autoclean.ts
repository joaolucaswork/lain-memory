import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Graph from 'graphology';
import { KNOWLEDGE_DIR } from './workspace.js';

const BLOCKLIST_PATH = join(KNOWLEDGE_DIR, 'graph-blocklist.json');

interface Blocklist {
  ids: string[];
  patterns: string[];
}

let blocklist: Blocklist = { ids: [], patterns: [] };
let compiledPatterns: RegExp[] = [];

// ─── Blocklist Management ───

export function loadBlocklist(override?: Blocklist): void {
  if (override) {
    blocklist = override;
  } else if (existsSync(BLOCKLIST_PATH)) {
    try {
      const data = JSON.parse(readFileSync(BLOCKLIST_PATH, 'utf-8'));
      blocklist = {
        ids: (data.ids || []).map((id: string) => id.toLowerCase().trim()),
        patterns: data.patterns || [],
      };
    } catch {
      console.warn('[autoclean] Failed to load blocklist, using empty');
      blocklist = { ids: [], patterns: [] };
    }
  }
  compiledPatterns = blocklist.patterns.map(p => new RegExp(p, 'i'));
}

export async function addToBlocklist(ids: string[]): Promise<void> {
  const normalized = ids.map(id => id.toLowerCase().trim());
  const existing = new Set(blocklist.ids);
  for (const id of normalized) existing.add(id);
  blocklist.ids = [...existing];
  await Bun.write(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2));
}

// ─── Pattern-Based Rejection ───

const REJECT_PATTERNS: RegExp[] = [
  /^[0-9a-f]{6,}$/,                          // commit hashes (bare)
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,   // IP addresses
  /^(get|post|put|delete|patch)\s+\//i,       // HTTP method + path
  /^https?$/i,                                // bare protocol
  /^[\d.]+$/,                                 // pure numbers
  /^\d{10,}$/,                                // phone numbers / long digits
  /^speaker\s*[\d/]/i,                        // speaker labels from transcription
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i,
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s/i,
  /\.(ts|js|py|json|md|swift|css|html)$/i,   // filenames
  /^port\s+\d+$/i,                            // "port 3334"
  /^--[\w-][\w-]*$/,                          // CLI flags "--dangerously-skip-permissions"
  /^commit\s+[a-f0-9]{5,}/i,                 // "commit 89b569a"
  /^v\d+\.\d+/,                              // version strings "v8.0", "v1.2.3"
  /\.(supabase\.co|vercel\.app|ngrok\.app)/,  // deployment URLs
  /^[a-z][a-z0-9]*(_[a-z0-9]+){2,}$/,       // snake_case vars: "event_id", "memory_id"
  /^\w+\.\w{2,}\.\w{2,}(\.\w+)+$/,          // multi-part URLs without protocol
];

export function shouldRejectEntity(id: string, _type: string): boolean {
  const normalized = id.toLowerCase().trim();

  if (normalized.length <= 3) return true;

  if (blocklist.ids.includes(normalized)) return true;

  for (const pattern of REJECT_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  for (const pattern of compiledPatterns) {
    if (pattern.test(normalized)) return true;
  }

  return false;
}

export function shouldRejectRelationship(source: string, _predicate: string, target: string): boolean {
  return shouldRejectEntity(source, 'Other') || shouldRejectEntity(target, 'Other');
}

// ─── Periodic Sweep ───

export interface SweepResult {
  orphansRemoved: number;
  patternRemoved: number;
  staleRemoved: number;
  total: number;
}

const STALE_THRESHOLD_DAYS = 14;

export function sweepGraph(graph: Graph): SweepResult {
  const result: SweepResult = { orphansRemoved: 0, patternRemoved: 0, staleRemoved: 0, total: 0 };
  const toRemove = new Set<string>();
  const now = Date.now();

  graph.forEachNode((nodeId, attrs) => {
    const a = attrs as { type: string; mentions: number; lastSeen: number };

    // 1. Remove pattern-matched garbage (even if connected)
    if (shouldRejectEntity(nodeId, a.type || 'Other')) {
      toRemove.add(nodeId);
      result.patternRemoved++;
      return;
    }

    // 2. Remove orphans (no edges)
    if (graph.degree(nodeId) === 0) {
      toRemove.add(nodeId);
      result.orphansRemoved++;
      return;
    }

    // 3. Remove stale low-mention nodes
    const daysSinceLastSeen = (now - (a.lastSeen || 0)) / 86400000;
    if (daysSinceLastSeen > STALE_THRESHOLD_DAYS && (a.mentions || 0) <= 2) {
      toRemove.add(nodeId);
      result.staleRemoved++;
      return;
    }
  });

  for (const nodeId of toRemove) {
    try { graph.dropNode(nodeId); } catch { /* already removed */ }
  }

  result.total = toRemove.size;
  return result;
}

// ─── Initialization ───

loadBlocklist();
