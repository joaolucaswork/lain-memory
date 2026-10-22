import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

function freshPath(): string {
  return join(tmpdir(), `pending-review-test-${randomBytes(6).toString('hex')}.json`);
}

// Import after setting env override per test (module reads env per call,
// so a static import is fine — each test passes an explicit file path).
import {
  enqueueVerdict,
  listPending,
  claimPendingMerges,
  updateEntry,
  dismissEntry,
  maxAttemptsReached,
} from './pending-review.js';

describe('pending-review queue', () => {
  let file: string;
  beforeEach(() => {
    file = freshPath();
  });

  it('enqueues and lists a merge candidate', async () => {
    const { entry, duplicate } = await enqueueVerdict(
      {
        kind: 'merge',
        verdict: 'UPDATE',
        scope: undefined,
        memoryId: 'mem-a',
        memory: 'Lucas prefers Bun',
        related: [{ id: 'mem-b', memory: 'Lucas prefers Bun for tooling' }],
        reason: 'extends',
      },
      file,
    );
    expect(duplicate).toBe(false);
    expect(entry.kind).toBe('merge');
    expect(listPending(undefined, file)).toHaveLength(1);
  });

  it('dedupes the same memoryId+verdict while pending', async () => {
    const input = {
      kind: 'contradiction' as const,
      verdict: 'DELETE' as const,
      scope: 'lain' as string | undefined,
      memoryId: 'mem-x',
      memory: 'X is English',
      related: [{ id: 'mem-y', memory: 'X is Portuguese' }],
      reason: 'direct contradiction',
    };
    const first = await enqueueVerdict(input, file);
    const second = await enqueueVerdict(input, file);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(listPending('contradiction', file)).toHaveLength(1);
  });

  it('claim bumps attempts and filters by scope', async () => {
    await enqueueVerdict(
      { kind: 'merge', verdict: 'UPDATE', scope: undefined, memoryId: 'g1', memory: 'a', related: [{ id: 'g2', memory: 'b' }], reason: 'r' },
      file,
    );
    await enqueueVerdict(
      { kind: 'merge', verdict: 'UPDATE', scope: 'proj', memoryId: 'p1', memory: 'a', related: [{ id: 'p2', memory: 'b' }], reason: 'r' },
      file,
    );
    const claimed = await claimPendingMerges(undefined, 5, file);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].memoryId).toBe('g1');
    expect(claimed[0].attempts).toBe(1);
    // Still pending (claimed, not done) — visible until resolved
    expect(listPending('merge', file)).toHaveLength(2);
  });

  it('stops claiming after max attempts', async () => {
    const { entry } = await enqueueVerdict(
      { kind: 'merge', verdict: 'UPDATE', scope: undefined, memoryId: 'm1', memory: 'a', related: [{ id: 'm2', memory: 'b' }], reason: 'r' },
      file,
    );
    await updateEntry(entry.id, { attempts: 3 }, file);
    const stored = listPending('merge', file)[0];
    expect(maxAttemptsReached(stored)).toBe(true);
    expect(await claimPendingMerges(undefined, 5, file)).toHaveLength(0);
  });

  it('dismiss removes from pending but keeps audit trail', async () => {
    const { entry } = await enqueueVerdict(
      { kind: 'contradiction', verdict: 'DELETE', scope: undefined, memoryId: 'd1', memory: 'a', related: [{ id: 'd2', memory: 'b' }], reason: 'r' },
      file,
    );
    expect(await dismissEntry(entry.id, file)).toBe(true);
    expect(listPending(undefined, file)).toHaveLength(0);
    expect(await dismissEntry('no-such-id', file)).toBe(false);
  });
});
