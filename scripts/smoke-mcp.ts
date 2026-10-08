#!/usr/bin/env bun
/**
 * Smoke test for the lain-memory MCP server (src/mcp.ts).
 *
 * Default: spawns the stdio server, runs initialize + tools/list, asserts
 * the 12 memory tools are exposed. No backends touched (no Qdrant/LLM needed).
 *
 *   bun run smoke
 *
 * --live: additionally proves the write path end to end against real
 * backends: Qdrant reachable? remember → recall (found?) → forget →
 * recall (gone?) in a throwaway `smoke-live-test` project, plus graph_stats.
 * Needs Qdrant up and a usable LLM key (same contract as llm-client).
 * Costs a few LLM calls.
 *
 *   bun run smoke --live
 */

const EXPECTED = [
  'remember', 'recall', 'forget', 'update_memory', 'list_memories', 'scan_memories',
  'graph_query', 'graph_stats', 'pgs_query', 'pgs_stats', 'seed_extract', 'list_seeds',
];

const LIVE_PROJECT = 'smoke-live-test';
const LIVE_TEXT = `Smoke-test marker ${new Date().toISOString()}: the Zephyr probe prefers violet over amber for dashboard accents.`;

const child = Bun.spawn(['bun', 'run', 'src/mcp.ts'], {
  cwd: import.meta.dir + '/..',
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});

function send(obj: unknown): void {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function readResponse(id: number, timeoutMs = 60_000): Promise<any> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj?.id === id) return obj;
        } catch { /* stdio noise — ignore */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`No response for request ${id} within ${timeoutMs}ms`);
}

let nextId = 10;
async function callTool(name: string, args: Record<string, unknown>, timeoutMs = 300_000): Promise<string> {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const res = await readResponse(id, timeoutMs);
  if (res?.error) throw new Error(`tool ${name}: protocol error ${JSON.stringify(res.error)}`);
  if (res?.result?.isError) throw new Error(`tool ${name}: ${res.result.content?.[0]?.text ?? 'unknown error'}`);
  return (res?.result?.content?.[0]?.text ?? '') as string;
}

const failures: string[] = [];
function check(cond: boolean, label: string, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
  if (!cond) failures.push(label);
}

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  }});
  await readResponse(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await readResponse(2);
  const names: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);
  const missing = EXPECTED.filter(n => !names.includes(n));
  console.log(`tools: ${names.length} (${names.join(', ')})`);
  check(missing.length === 0 && names.length === EXPECTED.length, 'tools/list exposes the 12 memory tools',
    missing.length > 0 ? `missing: ${missing.join(', ')}` : '');

  if (process.argv.includes('--live')) {
    // Pre-check: Qdrant reachable? (same env the server uses)
    const qhost = process.env.QDRANT_HOST ?? 'localhost';
    const qport = process.env.QDRANT_PORT ?? '6333';
    try {
      const r = await fetch(`http://${qhost}:${qport}/collections`);
      check(r.ok, `Qdrant reachable at ${qhost}:${qport}`);
      if (!r.ok) throw new Error('Qdrant unhealthy — aborting live checks');
    } catch (e) {
      check(false, `Qdrant reachable at ${qhost}:${qport}`, e instanceof Error ? e.message : String(e));
      throw new Error('Qdrant unhealthy — aborting live checks');
    }

    // NOTE: one remember can store SEVERAL atoms (Mem0 decomposes the text),
    // so track every returned id and forget them all.
    let markerIds: string[] = [];
    const liveStart = Date.now();
    try {
      const remembered = await callTool('remember', { text: LIVE_TEXT, project: LIVE_PROJECT, mode: 'atomic' });
      markerIds = [...remembered.matchAll(/\(id: ([0-9a-f-]{36})\)/g)].map(m => m[1]);
      check(markerIds.length > 0 && !remembered.includes('skipped') && !remembered.includes('rejected'),
        `live remember stores the marker (${markerIds.length} atom(s))`, remembered);
      const found = await callTool('recall', { query: 'Zephyr probe dashboard accents violet amber', project: LIVE_PROJECT, limit: 5 });
      check(markerIds.every(id => found.includes(id)),
        'live recall retrieves the marker atom(s)', found);
      const stats = await callTool('graph_stats', {});
      check(stats.includes('"nodes"'), 'live graph_stats reads the graph', stats);
    } finally {
      for (const id of markerIds) {
        try { await callTool('forget', { memory_id: id }); }
        catch (e) { check(false, `live cleanup (forget ${id})`, e instanceof Error ? e.message : String(e)); }
      }
      if (markerIds.length > 0) {
        const gone = await callTool('recall', { query: 'Zephyr probe dashboard accents', project: LIVE_PROJECT, limit: 5 });
        check(gone.includes('No memories found'), 'live forget removes all marker atoms', gone);
      }
      // remember also ingests entities into graph.json — remove nodes created
      // during this run (matched by firstSeen, not keywords). The MCP has no
      // remove-nodes tool; file surgery keeps zero residue. Deferred until
      // after the child is dead so no debounced flush can resurrect them.
      (globalThis as any).__liveStart = liveStart;
    }
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!failures.includes(msg)) failures.push(msg);
  console.error(`SMOKE ERROR: ${msg}`);
} finally {
  child.kill();
  await child.exited.catch(() => {});
  // Deferred graph cleanup (child is dead — no flush can resurrect nodes).
  const liveStart: number | undefined = (globalThis as any).__liveStart;
  if (process.argv.includes('--live') && liveStart) {
    try {
      const { KNOWLEDGE_DIR } = await import('../src/workspace.js');
      const { readFileSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const gpath = join(KNOWLEDGE_DIR, 'graph.json');
      const raw = JSON.parse(readFileSync(gpath, 'utf8'));
      const g = raw?.graph ?? raw;
      if (Array.isArray(g?.nodes)) {
        const keyOf = (n: any) => n.key ?? n.id;
        const drop = new Set<string>();
        for (const n of g.nodes) {
          const seen = n?.attributes?.firstSeen ?? n?.firstSeen ?? 0;
          if (typeof seen === 'number' && seen >= liveStart - 60_000) drop.add(keyOf(n));
        }
        if (drop.size > 0) {
          g.nodes = g.nodes.filter((n: any) => !drop.has(keyOf(n)));
          if (Array.isArray(g.edges)) {
            g.edges = g.edges.filter((e: any) =>
              !drop.has(e.source ?? e.from) && !drop.has(e.target ?? e.to));
          }
          writeFileSync(gpath, JSON.stringify(raw));
        }
        console.log(`PASS  live cleanup (graph nodes removed: ${drop.size}${drop.size > 0 ? ` — ${[...drop].join(', ')}` : ''})`);
      }
    } catch (e) {
      check(false, 'live cleanup (graph nodes)', e instanceof Error ? e.message : String(e));
    }
  }
}

if (failures.length > 0) {
  console.error(`smoke: FAIL (${failures.length})`);
  process.exit(1);
}
console.log(process.argv.includes('--live') ? 'smoke: OK (list + live write path)' : 'smoke: OK (12 memory tools over stdio)');
