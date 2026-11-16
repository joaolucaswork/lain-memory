import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';

import * as realMem0Ns from './mem0.js';
import * as realLlmNs from './llm-client.js';
import * as realMetricsNs from './mem-metrics.js';

const realMem0 = { ...realMem0Ns };
const realLlm = { ...realLlmNs };
const realMetrics = { ...realMetricsNs };

const mockGetMemories = mock(async (_project?: string, _limit?: number) => [] as any[]);
const mockAddMemory = mock(async (text: string, _project?: string, _opts?: any) => [
  { id: 'bundle-new-id', memory: text },
]);
const mockRunFastLlmJson = mock(async (_prompt: string, _opts?: any) => ({ consolidated: '' }) as any);

mock.module('./mem0.js', () => ({
  ...realMem0,
  getMemories: mockGetMemories,
  addMemory: mockAddMemory,
  withRetry: async (fn: () => Promise<any>) => fn(),
}));
mock.module('./llm-client.js', () => ({
  ...realLlm,
  runFastLlmJson: mockRunFastLlmJson,
}));
mock.module('./mem-metrics.js', () => ({
  ...realMetrics,
  incrementMetric: mock(() => undefined),
}));
mock.module('./maintenance-log.js', () => ({
  logMaintenance: mock(() => undefined),
  getMaintenanceLogs: () => [],
  getMaintenanceActions: () => [],
  ensureLogsDir: () => undefined,
  pruneMaintenanceLogs: () => undefined,
}));

const bundle = await import('./bundle-sweep.js');

const ENV_KEYS = ['LAIN_BUNDLE_ENABLED', 'LAIN_BUNDLE_DRY_RUN', 'LAIN_BUNDLE_FETCH_LIMIT'];
const savedEnv: Record<string, string | undefined> = {};

function recentISO(daysAgo = 1): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  ENV_KEYS.forEach(k => {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  });
  mockGetMemories.mockClear();
  mockAddMemory.mockClear();
  mockRunFastLlmJson.mockClear();
  bundle.stopBundleSweep();
});

afterEach(() => {
  ENV_KEYS.forEach(k => {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  });
  bundle.stopBundleSweep();
});

afterAll(() => {
  mock.module('./mem0.js', () => realMem0);
  mock.module('./llm-client.js', () => realLlm);
  mock.module('./mem-metrics.js', () => realMetrics);
});

describe('bundle-sweep pure helpers', () => {
  it('isBundleMemory detects prefix and metadata', () => {
    expect(bundle.isBundleMemory({ memory: '[Bundle: diario 2026-11-14] foo' })).toBe(true);
    expect(bundle.isBundleMemory({ memory: 'plain', metadata: { kind: 'bundle' } })).toBe(true);
    expect(bundle.isBundleMemory({ memory: 'plain fragment' })).toBe(false);
  });

  it('selectWeeklyCandidates keeps recent unbundled, drops old and bundles', () => {
    const now = Date.now();
    const mems = [
      { id: 'a', memory: 'recent one with enough context diario 14 novembro', created_at: recentISO(1) },
      { id: 'b', memory: 'recent two with enough context diario 14 novembro', created_at: recentISO(2) },
      { id: 'c', memory: 'old fragment', created_at: recentISO(30) },
      { id: 'd', memory: '[Bundle: diario 2026-11-07] previous digest', created_at: recentISO(1) },
    ];
    const sel = bundle.selectWeeklyCandidates(mems as any, { now, windowDays: 7 });
    expect(sel.map((m: any) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('bundleAlreadyExists guards near-duplicates', () => {
    const existing = [{ id: 'x', memory: 'ela veio na casa dele passaram a noite juntos' }];
    expect(
      bundle.bundleAlreadyExists('ela veio na casa dele passaram a noite juntos', existing as any),
    ).toBe(true);
    expect(bundle.bundleAlreadyExists('projeto interno usa OTP com Resend configurado', existing as any)).toBe(
      false,
    );
  });

  it('respects LAIN_BUNDLE_ENABLED=false', async () => {
    process.env.LAIN_BUNDLE_ENABLED = 'false';
    const res = await bundle.runBundleSweep();
    expect(res.disabled).toBe(true);
    expect(mockGetMemories).not.toHaveBeenCalled();
  });
});

describe('runBundleSweep non-destructive', () => {
  it('skips when fewer than 2 candidates', async () => {
    mockGetMemories.mockResolvedValue([
      { id: 'only', memory: 'unico fragmento recente do diario com contexto suficiente', created_at: recentISO(1) },
    ] as any);
    const res = await bundle.runBundleSweep({ now: Date.now() });
    expect(res.bundles).toBe(0);
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it('dry-run never saves', async () => {
    mockGetMemories.mockResolvedValue([
      { id: 'a', memory: 'ela veio na casa dele passaram a noite juntos caricias diario novembro', created_at: recentISO(1) },
      { id: 'b', memory: 'mandou directs no instagram ela disse exagerando diario novembro', created_at: recentISO(2) },
    ] as any);
    mockRunFastLlmJson.mockResolvedValue({ consolidated: 'Linha do tempo da garota: encontro na casa dele, directs no Instagram, resposta exagerando, hoje guarda com carinho.' } as any);
    const res = await bundle.runBundleSweep({ dryRun: true, now: Date.now() });
    expect(res.dryRun).toBe(true);
    expect(res.details[0]?.fragments).toBe(2);
    expect(mockAddMemory).not.toHaveBeenCalled();
  });

  it('live saves ONE bundle via index mode and preserves fragments', async () => {
    mockGetMemories.mockResolvedValue([
      { id: 'a', memory: 'ela veio na casa dele passaram a noite juntos caricias diario novembro', created_at: recentISO(1) },
      { id: 'b', memory: 'mandou directs no instagram ela disse exagerando diario novembro', created_at: recentISO(2) },
    ] as any);
    mockRunFastLlmJson.mockResolvedValue({ consolidated: 'Linha do tempo da garota: encontro na casa dele com caricias, carencia e directs no Instagram, ela respondeu exagerando, hoje ele ri e guarda a noite como bonita.' } as any);
    const res = await bundle.runBundleSweep({ now: Date.now() });
    expect(res.bundles).toBe(1);
    expect(mockAddMemory).toHaveBeenCalledTimes(1);
    const [text, project, opts] = mockAddMemory.mock.calls[0];
    expect(project).toBe('diario');
    expect(String(text).startsWith('[Bundle: diario')).toBe(true);
    // index mode: no conflict check, provenance metadata, never delete
    expect(opts).toMatchObject({
      skipConflictCheck: true,
      metadata: { kind: 'bundle', non_destructive: true },
    });
    expect(opts.metadata.bundle_of).toEqual(['a', 'b']);
    expect(res.details[0]?.bundleOf).toEqual(['a', 'b']);
  });
});
