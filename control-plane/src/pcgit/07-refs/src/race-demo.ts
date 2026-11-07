/**
 * 07-refs / race-demo.ts
 *
 * Executable proof of the concurrent-pusher trace in ../07-refs-design.md §5.
 *
 * Firestore is replaced with an in-memory fake that enforces the ONE property
 * we actually depend on — serializable isolation with automatic retry on
 * conflict — via per-document version stamps. Whether the real service gets
 * there pessimistically (Standard edition, our case) or optimistically
 * (Enterprise) is an implementation detail that this demo deliberately does
 * not model, because compareAndSetRef must be correct under either.
 *
 * The interleaving is forced, not hoped for: both transactions are made to
 * read before either commits.
 *
 * Run:  npx tsc --outDir dist && node dist/race-demo.js
 */

import type { Firestore } from 'firebase-admin/firestore';

import { RefStore } from './refs';
import type { RefDocument } from './model';

// --------------------------------------------------------------------------
// Minimal fake Firestore: enough surface for compareAndSetRef, nothing more.
// --------------------------------------------------------------------------

interface Stored {
  version: number;
  data: Record<string, unknown>;
}

class FakeDb {
  readonly docs = new Map<string, Stored>();
  /** Set by the test to force both transactions to read before either writes. */
  barrier: (() => Promise<void>) | null = null;
  attempts = 0;

  private snapshot(path: string) {
    const stored = this.docs.get(path);
    return {
      exists: stored !== undefined,
      data: () => stored?.data,
      __version: stored?.version ?? 0,
    };
  }

  async runTransaction<T>(
    fn: (tx: FakeTx) => Promise<T>,
    options?: { maxAttempts?: number },
  ): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.attempts++;
      const tx = new FakeTx(this);
      const result = await fn(tx);
      if (this.barrier) await this.barrier();
      // Commit: every document read must still be at the version we saw.
      const conflict = [...tx.reads].some(([p, v]) => (this.docs.get(p)?.version ?? 0) !== v);
      if (conflict) {
        if (attempt === maxAttempts) {
          const err = new Error('ABORTED: Too much contention on these documents. Please try again.');
          (err as { code?: number }).code = 10;
          throw err;
        }
        continue; // Firestore retries the whole update function.
      }
      for (const w of tx.writes) {
        if (w.kind === 'delete') this.docs.delete(w.path);
        else this.docs.set(w.path, { version: (this.docs.get(w.path)?.version ?? 0) + 1, data: w.data });
      }
      return result;
    }
    /* unreachable */ throw new Error('unreachable');
  }

  __snapshot(path: string) {
    return this.snapshot(path);
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }
}

class FakeCollection {
  constructor(private db: FakeDb, private path: string) {}
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }
  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, s]) => ({ id: p.slice(prefix.length), data: () => s.data }));
    return { docs };
  }
}

class FakeDocRef {
  constructor(readonly db: FakeDb, readonly path: string) {}
  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
  async get() {
    return this.db.__snapshot(this.path);
  }
}

type FakeWrite =
  | { kind: 'set'; path: string; data: Record<string, unknown> }
  | { kind: 'delete'; path: string };

class FakeTx {
  readonly reads = new Map<string, number>();
  readonly writes: FakeWrite[] = [];
  constructor(private db: FakeDb) {}
  async get(ref: FakeDocRef) {
    const snap = this.db.__snapshot(ref.path);
    this.reads.set(ref.path, snap.__version);
    return snap;
  }
  set(ref: FakeDocRef, data: Record<string, unknown>) {
    this.writes.push({ kind: 'set', path: ref.path, data });
  }
  delete(ref: FakeDocRef) {
    this.writes.push({ kind: 'delete', path: ref.path });
  }
}

// --------------------------------------------------------------------------
// The race.
// --------------------------------------------------------------------------

const BASE = 'a'.repeat(40);
const AGENT_A_TIP = 'b'.repeat(40);
const AGENT_B_TIP = 'c'.repeat(40);

async function main(): Promise<void> {
  const fake = new FakeDb();
  const db = fake as unknown as Firestore;

  const storeA = new RefStore({ firestore: db, writerId: 'agent-A', maxTransientRetries: 0 });
  const storeB = new RefStore({ firestore: db, writerId: 'agent-B', maxTransientRetries: 0 });

  // Seed refs/heads/main at BASE, as if a previous push had landed.
  fake.docs.set('repos/demo/refs/refs%2Fheads%2Fmain', {
    version: 1,
    data: { ref: 'refs/heads/main', oid: BASE, generation: 1, updatedBy: 'seed' } satisfies Partial<RefDocument> as Record<string, unknown>,
  });

  // Force both transactions to complete their reads before either commits.
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fake.barrier = async () => {
    waiting++;
    if (waiting >= 2) release();
    else await gate;
    fake.barrier = null; // only gate the first round; retries proceed freely
  };

  const [a, b] = await Promise.all([
    storeA.compareAndSetRef('demo', 'refs/heads/main', BASE, AGENT_A_TIP),
    storeB.compareAndSetRef('demo', 'refs/heads/main', BASE, AGENT_B_TIP),
  ]);

  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  const final = fake.docs.get('repos/demo/refs/refs%2Fheads%2Fmain')?.data as RefDocument | undefined;

  console.log('agent A ->', JSON.stringify(a));
  console.log('agent B ->', JSON.stringify(b));
  console.log('final ref oid ->', final?.oid);
  console.log('generation    ->', final?.generation);
  console.log('transaction attempts (incl. retries) ->', fake.attempts);

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
    console.log(`  ok: ${msg}`);
  };

  console.log('\nInvariants:');
  assert(winners.length === 1, 'exactly one pusher wins');
  assert(losers.length === 1, 'exactly one pusher is told it lost');
  assert(losers[0]?.ok === false && losers[0].code === 'STALE', 'the loser gets code STALE, not silence');
  assert(
    losers[0]?.ok === false && losers[0].actualOid === final?.oid,
    'the loser is told the winning oid so it can fetch and rebase',
  );
  assert(final?.oid === AGENT_A_TIP || final?.oid === AGENT_B_TIP, 'the ref holds one real tip');
  assert(final?.generation === 2, 'exactly one generation was consumed: no double-apply');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
