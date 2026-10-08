#!/usr/bin/env bun
/**
 * Smoke test for the lain-memory MCP server (src/mcp.ts).
 *
 * Spawns the stdio server, runs initialize + tools/list, asserts the 12
 * memory tools are exposed. No backends touched (no Qdrant/LLM needed).
 *
 * Usage: bun run scripts/smoke-mcp.ts  (or: bun run smoke)
 */

const EXPECTED = [
  'remember', 'recall', 'forget', 'update_memory', 'list_memories', 'scan_memories',
  'graph_query', 'graph_stats', 'pgs_query', 'pgs_stats', 'seed_extract', 'list_seeds',
];

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

let failed = false;
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
  const extra = names.filter(n => !EXPECTED.includes(n));
  console.log(`tools: ${names.length} (${names.join(', ')})`);
  if (missing.length > 0) {
    console.error(`MISSING: ${missing.join(', ')}`);
    failed = true;
  }
  if (extra.length > 0) console.log(`(note) extra tools: ${extra.join(', ')}`);
  if (names.length !== EXPECTED.length && missing.length === 0) {
    console.error(`expected ${EXPECTED.length} tools, got ${names.length}`);
    failed = true;
  }
} catch (e) {
  console.error(`SMOKE FAILED: ${e instanceof Error ? e.message : String(e)}`);
  failed = true;
} finally {
  child.kill();
  await child.exited.catch(() => {});
}

if (failed) {
  console.error('smoke: FAIL');
  process.exit(1);
}
console.log('smoke: OK (12 memory tools over stdio)');
