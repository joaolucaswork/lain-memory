import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { isReaperDryRun, getReaperFetchLimit } from './memory-reaper.js';

export type ReaperDoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface ReaperDoctorCheck {
  name: string;
  status: ReaperDoctorCheckStatus;
  detail?: string;
}

const DISABLED_VALUES = new Set(['false', '0', 'no']);

// Reads env fresh at call time — same precedence as memory-reaper-audit.ts but not cached at module load.
function resolveAuditPath(): string {
  if (process.env.LAIN_REAPER_AUDIT_PATH) {
    return process.env.LAIN_REAPER_AUDIT_PATH;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.lain', 'audit', 'memory-reaper.log.jsonl');
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Reads LAIN_PROJECTS_BASE fresh at call time so tests can drive via env vars
// without hitting the module-cached PROJECTS_BASE constant in workspace.ts.
function listProjectsLive(): Array<{ name: string; path: string }> {
  const base = process.env.LAIN_PROJECTS_BASE ?? join(homedir(), 'Documents', 'GitHub');
  if (!base) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        if (e.isDirectory()) return true;
        if (e.isSymbolicLink()) {
          try { return statSync(join(base, e.name)).isDirectory(); }
          catch { return false; }
        }
        return false;
      })
      .map(e => ({ name: e.name, path: join(base, e.name) }));
  } catch {
    return [];
  }
}

async function checkEnabled(): Promise<ReaperDoctorCheck> {
  try {
    const val = process.env.LAIN_MEMORY_REAPER_ENABLED ?? '';
    if (DISABLED_VALUES.has(val)) {
      return { name: 'enabled', status: 'warn', detail: 'reaper disabled via env' };
    }
    return { name: 'enabled', status: 'ok', detail: 'reaper enabled' };
  } catch (e) {
    return { name: 'enabled', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkMode(): Promise<ReaperDoctorCheck> {
  try {
    const dryRun = isReaperDryRun();
    return {
      name: 'mode',
      status: 'info',
      detail: dryRun ? 'dry-run (no deletions)' : 'live (deletions executed)',
    };
  } catch (e) {
    return { name: 'mode', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkFetchLimit(): Promise<ReaperDoctorCheck> {
  try {
    const n = getReaperFetchLimit();
    return {
      name: 'fetch-limit',
      status: 'info',
      detail: `fetch limit per project per sweep: ${n} (env LAIN_MEMORY_REAPER_FETCH_LIMIT)`,
    };
  } catch (e) {
    return { name: 'fetch-limit', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkProjectsBase(): Promise<ReaperDoctorCheck> {
  try {
    const envVal = process.env.LAIN_PROJECTS_BASE;

    if (envVal !== undefined && envVal === '') {
      return {
        name: 'projects-base',
        status: 'warn',
        detail: 'LAIN_PROJECTS_BASE is set to empty string — listProjects() will fail; unset or set a real path',
      };
    }

    const path = envVal ?? join(homedir(), 'Documents', 'GitHub');

    let isDir = false;
    try {
      isDir = existsSync(path) && statSync(path).isDirectory();
    } catch {
      isDir = false;
    }

    if (!isDir) {
      return { name: 'projects-base', status: 'fail', detail: `${path} not found` };
    }

    return { name: 'projects-base', status: 'ok', detail: path };
  } catch (e) {
    return { name: 'projects-base', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkProjectsFound(): Promise<ReaperDoctorCheck> {
  try {
    const projects = listProjectsLive();
    const count = projects.length;
    if (count === 0) {
      return {
        name: 'projects-found',
        status: 'warn',
        detail: 'no projects found at PROJECTS_BASE — reaper sweeps will be no-ops',
      };
    }
    const names = projects.map(p => p.name);
    const displayNames = names.length > 5 ? names.slice(0, 5).join(', ') + '…' : names.join(', ');
    return {
      name: 'projects-found',
      status: 'ok',
      detail: `${count} project(s): ${displayNames}`,
    };
  } catch (e) {
    return { name: 'projects-found', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkAuditLogPath(): Promise<ReaperDoctorCheck> {
  try {
    const path = resolveAuditPath();
    const exists = existsSync(path);
    return {
      name: 'audit-log-path',
      status: 'info',
      detail: `${path} (exists: ${exists ? 'yes' : 'no'})`,
    };
  } catch (e) {
    return { name: 'audit-log-path', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkAuditLogSize(): Promise<ReaperDoctorCheck> {
  try {
    const path = resolveAuditPath();
    if (!existsSync(path)) {
      return { name: 'audit-log-size', status: 'info', detail: 'audit log not yet created (no sweeps run)' };
    }
    const { size } = statSync(path);
    if (size >= 50 * 1024 * 1024) {
      return { name: 'audit-log-size', status: 'warn', detail: `${formatBytes(size)} — consider rotation` };
    }
    return { name: 'audit-log-size', status: 'info', detail: formatBytes(size) };
  } catch (e) {
    return { name: 'audit-log-size', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

async function checkLastSweep(): Promise<ReaperDoctorCheck> {
  try {
    const path = resolveAuditPath();

    let tail: string;
    try {
      tail = execSync(`tail -n 500 "${path}"`, { encoding: 'utf8' });
    } catch {
      return { name: 'last-sweep', status: 'info', detail: 'no sweeps in audit log yet' };
    }

    const lines = tail.split('\n').filter(l => l.trim() !== '');
    let corrupted = 0;
    let lastComplete: Record<string, unknown> | null = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        corrupted++;
        continue;
      }
      if (parsed['event_type'] === 'complete' && lastComplete === null) {
        lastComplete = parsed;
      }
    }

    if (lastComplete === null) {
      let detail = 'no completed sweep found in last 500 audit lines';
      if (corrupted > 0) detail += ` (note: ${corrupted} corrupted line(s) in tail)`;
      return { name: 'last-sweep', status: 'warn', detail };
    }

    const ts = lastComplete['ts'] as string;
    const daysAgo = (Date.now() - new Date(ts).getTime()) / 86400000;
    const dryRun = lastComplete['dry_run'] as boolean;
    const purgedCount = dryRun ? (lastComplete['dry_purged'] ?? 0) : (lastComplete['purged'] ?? 0);
    const purgedLabel = dryRun ? 'dry_purged' : 'purged';

    let detail = `${ts} (${daysAgo.toFixed(1)} days ago), dry_run=${dryRun}, ${purgedLabel}=${purgedCount}, duration_ms=${lastComplete['duration_ms']}`;
    if (corrupted > 0) detail += ` (note: ${corrupted} corrupted line(s) in tail)`;

    if (daysAgo > 14) {
      return { name: 'last-sweep', status: 'warn', detail: `STALE: ${detail}` };
    }
    return { name: 'last-sweep', status: 'info', detail };
  } catch (e) {
    return { name: 'last-sweep', status: 'fail', detail: 'check threw: ' + String(e) };
  }
}

export async function runReaperDoctor(): Promise<ReaperDoctorCheck[]> {
  const checks: Array<[string, () => Promise<ReaperDoctorCheck>]> = [
    ['enabled', checkEnabled],
    ['mode', checkMode],
    ['fetch-limit', checkFetchLimit],
    ['projects-base', checkProjectsBase],
    ['projects-found', checkProjectsFound],
    ['audit-log-path', checkAuditLogPath],
    ['audit-log-size', checkAuditLogSize],
    ['last-sweep', checkLastSweep],
  ];

  const results: ReaperDoctorCheck[] = [];
  for (const [name, fn] of checks) {
    try {
      results.push(await fn());
    } catch (e) {
      results.push({ name, status: 'fail', detail: 'check threw: ' + String(e) });
    }
  }
  return results;
}

export function formatReaperDoctorReport(results: ReaperDoctorCheck[]): string {
  const lines: string[] = ['lain doctor — memory reaper', '─'.repeat(40), ''];
  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : 'ℹ';
    lines.push(`  ${icon} ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
  }
  const ok = results.filter(r => r.status === 'ok').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const info = results.filter(r => r.status === 'info').length;
  lines.push('');
  lines.push(`${results.length} checks — ${ok} ok  ${warn} warn  ${fail} fail  ${info} info`);
  return lines.join('\n');
}

if (import.meta.main) {
  runReaperDoctor().then(results => {
    console.log(formatReaperDoctorReport(results));
    const failed = results.some(r => r.status === 'fail');
    process.exit(failed ? 1 : 0);
  });
}
