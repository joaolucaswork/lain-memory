/**
 * Maintenance Log — tracks all automated maintenance actions
 * (memory consolidation, graph autoclean, entity resolution, memory scan, etc.)
 * Persists to JSONL for easy tailing and retrieval.
 */

import { join } from 'path';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { WORKSPACE_DIR } from './workspace.js';

const LOGS_DIR = join(WORKSPACE_DIR, '.maintenance-logs');
const LOG_FILE = join(LOGS_DIR, 'maintenance.jsonl');
const MAX_ENTRIES = 500; // prune beyond this

export interface MaintenanceLogEntry {
  timestamp: number;      // unix ms
  action: string;         // e.g. "memory_consolidation", "graph_autoclean", "entity_resolution", "memory_scan"
  details: Record<string, unknown>;
  duration_ms?: number;
}

export function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function logMaintenance(action: string, details: Record<string, unknown>, duration_ms?: number): void {
  ensureLogsDir();
  const entry: MaintenanceLogEntry = {
    timestamp: Date.now(),
    action,
    details,
    duration_ms,
  };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[maintenance-log] Failed to write log:', err);
  }
}

export function getMaintenanceLogs(limit: number = 100, action?: string): MaintenanceLogEntry[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    let entries: MaintenanceLogEntry[] = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (action) {
      entries = entries.filter(e => e.action === action);
    }

    // Return most recent first
    return entries.reverse().slice(0, limit);
  } catch (err) {
    console.error('[maintenance-log] Failed to read logs:', err);
    return [];
  }
}

export function getMaintenanceActions(): { action: string; count: number; lastRun: number }[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const actionMap = new Map<string, { count: number; lastRun: number }>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MaintenanceLogEntry;
        const existing = actionMap.get(entry.action);
        if (!existing) {
          actionMap.set(entry.action, { count: 1, lastRun: entry.timestamp });
        } else {
          existing.count++;
          if (entry.timestamp > existing.lastRun) {
            existing.lastRun = entry.timestamp;
          }
        }
      } catch { /* skip malformed lines */ }
    }

    return Array.from(actionMap.entries())
      .map(([action, data]) => ({ action, ...data }))
      .sort((a, b) => b.lastRun - a.lastRun);
  } catch {
    return [];
  }
}

export function pruneMaintenanceLogs(): void {
  if (!existsSync(LOG_FILE)) return;
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length <= MAX_ENTRIES) return;
    // Keep the most recent MAX_ENTRIES lines
    const trimmed = lines.slice(lines.length - MAX_ENTRIES);
    Bun.write(LOG_FILE, trimmed.join('\n') + '\n');
    console.log(`[maintenance-log] Pruned ${lines.length - MAX_ENTRIES} old entries`);
  } catch (err) {
    console.error('[maintenance-log] Failed to prune logs:', err);
  }
}
