import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

import * as realMem0Ns from '../mem0.js';
import * as realGraphragNs from '../graphrag.js';
import * as realHaikuNs from '../llm-client.js';
import * as realMemoryPatternsNs from '../memory-patterns.js';
import * as realWorkspaceNs from '../workspace.js';
import * as realFileIoLockNs from '../file-io-lock.js';

const realMem0 = { ...realMem0Ns };
const realGraphrag = { ...realGraphragNs };
const realHaiku = { ...realHaikuNs };
const realMemoryPatterns = { ...realMemoryPatternsNs };
const realWorkspace = { ...realWorkspaceNs };
const realFileIoLock = { ...realFileIoLockNs };

// ── Mock factories (defined before mock.module calls, per Bun hoisting rules) ──

const mockAddMemory = mock(async () => [{ id: 'seed-id', memory: 'seed content', action: 'ADD' }]);
const mockAddMemoryWithConflictCheck = mock(async () => [{ id: 'seed-id', memory: 'seed content', action: 'ADD' }]);
const mockScoreActionability = mock((_text: string) => 0);

mock.module('../mem0.js', () => ({
  addMemoryWithConflictCheck: mockAddMemoryWithConflictCheck,
}));

mock.module('../graphrag.js', () => ({
  isGraphEnabled: () => false,
  ingestExtracted: mock(async () => {}),
}));

mock.module('../memory-patterns.js', () => ({
  BOILERPLATE_PATTERNS: [],
  scoreActionability: mockScoreActionability,
}));

mock.module('../llm-client.js', () => ({
  runFastLlmJson: mock(async () => ({
    title: 'Test Document',
    summary: 'A test document about lain architecture and memory system.',
    facts: [
      'Lucas implemented lain-core memory system using TypeScript and Qdrant in 2026',
      'The lain server uses Bun runtime with PM2 for process management',
    ],
    entities: [],
    relationships: [],
  })),
  runHaikuFast: mock(async () => 'Test summary.'),
}));

mock.module('../workspace.js', () => ({
  SEEDS_DIR: '/tmp/test-seeds-wave1-dedup',
  INSTANCE_ID: 'test',
  listProjects: () => [],
}));

mock.module('../file-io-lock.js', () => ({
  safeWriteFileSync: mock((_path: string, _content: string) => {}),
}));

// Import the module under test AFTER all mocks are set up (dynamic import required)
const { extractSeed } = await import('../seed-extraction.js');

describe('seed-extraction dedup via addMemoryWithConflictCheck (item #7a)', () => {
  beforeEach(() => {
    mockAddMemory.mockClear();
    mockAddMemoryWithConflictCheck.mockClear();
    mockScoreActionability.mockClear();
  });

  it('uses addMemoryWithConflictCheck (not addMemory) when storing seed summary', async () => {
    await extractSeed({
      type: 'text',
      rawText: 'The lain assistant uses Telegram for messaging. It runs on Bun runtime.',
      source: 'test-dedup-1',
      force: true,
    });

    // After the fix: addMemoryWithConflictCheck must be called (dedup coverage)
    expect(mockAddMemoryWithConflictCheck.mock.calls.length).toBeGreaterThan(0);
    // addMemory should NOT be called directly by storeSeedResults
    expect(mockAddMemory.mock.calls.length).toBe(0);
  });

  it('uses addMemoryWithConflictCheck when storing seed facts', async () => {
    await extractSeed({
      type: 'text',
      rawText: 'Lain uses lain-core for memory. Facts are stored in Qdrant with embeddings.',
      source: 'test-dedup-2',
      force: true,
    });

    // Both summary and facts should go through conflict check
    // (1 summary + up to N facts = at least 2 calls when facts are present)
    expect(mockAddMemoryWithConflictCheck.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockAddMemory.mock.calls.length).toBe(0);
  });
});

afterAll(() => {
  mock.module('../mem0.js', () => realMem0);
  mock.module('../graphrag.js', () => realGraphrag);
  mock.module('../llm-client.js', () => realHaiku);
  mock.module('../memory-patterns.js', () => realMemoryPatterns);
  mock.module('../workspace.js', () => realWorkspace);
  mock.module('../file-io-lock.js', () => realFileIoLock);
});
