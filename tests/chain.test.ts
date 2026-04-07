/**
 * Tests for core hash chain logic: computeHash, writeRecord, getRecord, getRecords, verifyChain.
 *
 * Mocks R2 and D1 bindings to test in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeHash, writeRecord, getRecord, getRecords, verifyChain } from '../src/chain';
import { GENESIS_HASH } from '../src/types';
import type { AuditBindings, AuditRecord, R2Bucket, D1Database } from '../src/types';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** In-memory R2 mock that stores JSON strings keyed by path. */
function createMockR2(): R2Bucket & { _store: Map<string, string> } {
  const store = new Map<string, string>();

  return {
    _store: store,
    async put(key: string, value: string | ArrayBuffer | ReadableStream) {
      store.set(key, typeof value === 'string' ? value : '');
    },
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return { text: async () => data };
    },
    async list(options: { prefix: string }) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(options.prefix))
        .map((key) => ({ key }));
      return { objects };
    },
  };
}

/** In-memory D1 mock with just enough fidelity for insertIndex / queryIndex. */
function createMockD1(): D1Database & { _rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];

  const stmt = (query: string) => {
    let boundValues: unknown[] = [];

    const self = {
      bind(...values: unknown[]) {
        boundValues = values;
        return self;
      },
      async run() {
        // INSERT path — store the bound values as a row
        if (query.trim().toUpperCase().startsWith('INSERT')) {
          const cols = [
            'record_id',
            'namespace',
            'event_type',
            'hash',
            'prev_hash',
            'actor',
            'timestamp',
            'payload_summary',
          ];
          const row: Record<string, unknown> = {};
          cols.forEach((c, i) => (row[c] = boundValues[i]));
          row.created_at = new Date().toISOString();
          rows.push(row);
        }
        return {};
      },
      async all<T = unknown>() {
        // SELECT path — very simplified: return all rows (filtering tested in index-store.test.ts)
        return { results: rows as T[] };
      },
    };

    return self;
  };

  return {
    _rows: rows,
    prepare: stmt,
  };
}

function createBindings(): AuditBindings & {
  _r2: ReturnType<typeof createMockR2>;
  _d1: ReturnType<typeof createMockD1>;
} {
  const r2 = createMockR2();
  const d1 = createMockD1();
  return {
    AUDIT_BUCKET: r2,
    AUDIT_DB: d1,
    _r2: r2,
    _d1: d1,
  };
}

// ---------------------------------------------------------------------------
// computeHash
// ---------------------------------------------------------------------------

describe('computeHash', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await computeHash(GENESIS_HASH, new Uint8Array([1, 2, 3]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs yield same output', async () => {
    const data = new TextEncoder().encode('hello');
    const h1 = await computeHash('abc', data);
    const h2 = await computeHash('abc', data);
    expect(h1).toBe(h2);
  });

  it('changes when prevHash changes', async () => {
    const data = new TextEncoder().encode('hello');
    const h1 = await computeHash('aaa', data);
    const h2 = await computeHash('bbb', data);
    expect(h1).not.toBe(h2);
  });

  it('changes when recordBytes change', async () => {
    const h1 = await computeHash('same', new TextEncoder().encode('alpha'));
    const h2 = await computeHash('same', new TextEncoder().encode('beta'));
    expect(h1).not.toBe(h2);
  });

  it('handles empty recordBytes', async () => {
    const hash = await computeHash(GENESIS_HASH, new Uint8Array([]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes prevHash in the computation (not just recordBytes)', async () => {
    // Hash with genesis should differ from hash with different prevHash even on same data
    const data = new TextEncoder().encode('test');
    const withGenesis = await computeHash(GENESIS_HASH, data);
    const withOther = await computeHash('f'.repeat(64), data);
    expect(withGenesis).not.toBe(withOther);
  });
});

// ---------------------------------------------------------------------------
// writeRecord
// ---------------------------------------------------------------------------

describe('writeRecord', () => {
  let bindings: ReturnType<typeof createBindings>;

  beforeEach(() => {
    bindings = createBindings();
  });

  it('returns a record with a valid hash and record_id', async () => {
    const { record, newChainHead } = await writeRecord(bindings, {
      namespace: 'test-ns',
      chainHead: GENESIS_HASH,
      event_type: 'user.created',
      actor: 'admin',
      payload: { user: 'alice' },
    });

    expect(record.record_id).toBeTruthy();
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.namespace).toBe('test-ns');
    expect(record.event_type).toBe('user.created');
    expect(record.actor).toBe('admin');
    expect(record.prev_hash).toBe(GENESIS_HASH);
    expect(record.payload).toEqual({ user: 'alice' });
    expect(newChainHead).toBe(record.hash);
  });

  it('writes the record to R2', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'test-ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    const key = `audit/test-ns/${record.record_id}.json`;
    expect(bindings._r2._store.has(key)).toBe(true);

    const stored = JSON.parse(bindings._r2._store.get(key)!);
    expect(stored.record_id).toBe(record.record_id);
    expect(stored.hash).toBe(record.hash);
  });

  it('indexes the record in D1', async () => {
    await writeRecord(bindings, {
      namespace: 'test-ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: { key: 'value' },
    });

    expect(bindings._d1._rows.length).toBe(1);
    expect(bindings._d1._rows[0].namespace).toBe('test-ns');
  });

  it('chains records by linking prevHash to the previous head', async () => {
    const { newChainHead: head1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'a',
      actor: 'bot',
      payload: {},
    });

    const { record: r2 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: head1,
      event_type: 'b',
      actor: 'bot',
      payload: {},
    });

    expect(r2.prev_hash).toBe(head1);
  });

  it('uses GENESIS_HASH when chainHead is empty string', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: '',
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    expect(record.prev_hash).toBe(GENESIS_HASH);
  });

  it('includes optional metadata when provided', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
      metadata: { correlation_id: 'abc-123' },
    });

    expect(record.metadata).toEqual({ correlation_id: 'abc-123' });
  });

  it('omits metadata key entirely when not provided', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    expect('metadata' in record).toBe(false);
  });

  it('produces unique record IDs for consecutive writes', async () => {
    const { record: r1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    const { record: r2 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: r1.hash,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    expect(r1.record_id).not.toBe(r2.record_id);
  });
});

// ---------------------------------------------------------------------------
// getRecord
// ---------------------------------------------------------------------------

describe('getRecord', () => {
  let bindings: ReturnType<typeof createBindings>;

  beforeEach(() => {
    bindings = createBindings();
  });

  it('retrieves a previously written record', async () => {
    const { record: written } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: { x: 1 },
    });

    const fetched = await getRecord(bindings, 'ns', written.record_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.record_id).toBe(written.record_id);
    expect(fetched!.hash).toBe(written.hash);
    expect(fetched!.payload).toEqual({ x: 1 });
  });

  it('returns null for a non-existent record ID', async () => {
    const result = await getRecord(bindings, 'ns', 'does-not-exist');
    expect(result).toBeNull();
  });

  it('returns null when namespace does not match', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns-a',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    // Same record ID but wrong namespace
    const result = await getRecord(bindings, 'ns-b', record.record_id);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRecords
// ---------------------------------------------------------------------------

describe('getRecords', () => {
  let bindings: ReturnType<typeof createBindings>;

  beforeEach(() => {
    bindings = createBindings();
  });

  it('returns an empty array for a namespace with no records', async () => {
    const records = await getRecords(bindings, 'empty-ns');
    expect(records).toEqual([]);
  });

  it('returns all records for a namespace sorted by timestamp', async () => {
    const { newChainHead: h1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'first',
      actor: 'bot',
      payload: {},
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: h1,
      event_type: 'second',
      actor: 'bot',
      payload: {},
    });

    const records = await getRecords(bindings, 'ns');
    expect(records.length).toBe(2);
    // Sorted ascending by timestamp
    expect(records[0].event_type).toBe('first');
    expect(records[1].event_type).toBe('second');
  });

  it('isolates records by namespace', async () => {
    await writeRecord(bindings, {
      namespace: 'ns-a',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    await writeRecord(bindings, {
      namespace: 'ns-b',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    const nsA = await getRecords(bindings, 'ns-a');
    const nsB = await getRecords(bindings, 'ns-b');

    expect(nsA.length).toBe(1);
    expect(nsB.length).toBe(1);
    expect(nsA[0].namespace).toBe('ns-a');
    expect(nsB[0].namespace).toBe('ns-b');
  });
});

// ---------------------------------------------------------------------------
// verifyChain
// ---------------------------------------------------------------------------

describe('verifyChain', () => {
  let bindings: ReturnType<typeof createBindings>;

  beforeEach(() => {
    bindings = createBindings();
  });

  it('returns valid: true for an empty namespace', async () => {
    const result = await verifyChain(bindings, 'empty');
    expect(result.valid).toBe(true);
    expect(result.record_count).toBe(0);
  });

  it('validates a single-record chain', async () => {
    await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: {},
    });

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(true);
    expect(result.record_count).toBe(1);
  });

  it('validates a multi-record chain', async () => {
    const { newChainHead: h1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'a',
      actor: 'bot',
      payload: { step: 1 },
    });

    // Small delay to ensure distinct timestamps for ordering
    await new Promise((r) => setTimeout(r, 5));

    const { newChainHead: h2 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: h1,
      event_type: 'b',
      actor: 'bot',
      payload: { step: 2 },
    });

    await new Promise((r) => setTimeout(r, 5));

    await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: h2,
      event_type: 'c',
      actor: 'bot',
      payload: { step: 3 },
    });

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(true);
    expect(result.record_count).toBe(3);
  });

  it('detects a tampered hash', async () => {
    const { record, newChainHead: h1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: { original: true },
    });

    // Tamper with the stored record in R2
    const key = `audit/ns/${record.record_id}.json`;
    const tampered = { ...record, hash: 'a'.repeat(64) };
    bindings._r2._store.set(key, JSON.stringify(tampered));

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(record.record_id);
    expect(result.error).toContain('Hash mismatch');
  });

  it('detects a tampered payload', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'bot',
      payload: { amount: 100 },
    });

    // Tamper with payload but keep original hash
    const key = `audit/ns/${record.record_id}.json`;
    const tampered = { ...record, payload: { amount: 999 } };
    bindings._r2._store.set(key, JSON.stringify(tampered));

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(record.record_id);
  });

  it('detects a tampered actor', async () => {
    const { record } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'evt',
      actor: 'admin',
      payload: {},
    });

    const key = `audit/ns/${record.record_id}.json`;
    const tampered = { ...record, actor: 'impersonator' };
    bindings._r2._store.set(key, JSON.stringify(tampered));

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(false);
  });

  it('detects a tampered prev_hash (broken link)', async () => {
    const { newChainHead: h1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'a',
      actor: 'bot',
      payload: {},
    });

    await new Promise((r) => setTimeout(r, 5));

    const { record: r2 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: h1,
      event_type: 'b',
      actor: 'bot',
      payload: {},
    });

    // Tamper with prev_hash of second record
    const key = `audit/ns/${r2.record_id}.json`;
    const tampered = { ...r2, prev_hash: 'b'.repeat(64) };
    bindings._r2._store.set(key, JSON.stringify(tampered));

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(r2.record_id);
  });

  it('validates chain with metadata records', async () => {
    const { newChainHead: h1 } = await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: GENESIS_HASH,
      event_type: 'a',
      actor: 'bot',
      payload: {},
      metadata: { trace: '123' },
    });

    await new Promise((r) => setTimeout(r, 5));

    await writeRecord(bindings, {
      namespace: 'ns',
      chainHead: h1,
      event_type: 'b',
      actor: 'bot',
      payload: {},
    });

    const result = await verifyChain(bindings, 'ns');
    expect(result.valid).toBe(true);
    expect(result.record_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GENESIS_HASH constant
// ---------------------------------------------------------------------------

describe('GENESIS_HASH', () => {
  it('is 64 hex zeros', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(GENESIS_HASH.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Round-trip integrity
// ---------------------------------------------------------------------------

describe('round-trip integrity', () => {
  it('written record matches fetched record exactly', async () => {
    const bindings = createBindings();

    const { record: written } = await writeRecord(bindings, {
      namespace: 'integrity',
      chainHead: GENESIS_HASH,
      event_type: 'test',
      actor: 'ci',
      payload: { nested: { deep: [1, 2, 3] } },
      metadata: { tags: ['a', 'b'] },
    });

    const fetched = await getRecord(bindings, 'integrity', written.record_id);
    expect(fetched).toEqual(written);
  });

  it('fetched record passes hash verification', async () => {
    const bindings = createBindings();

    const { record } = await writeRecord(bindings, {
      namespace: 'verify',
      chainHead: GENESIS_HASH,
      event_type: 'test',
      actor: 'ci',
      payload: { data: 'value' },
    });

    // Manually recompute the hash and confirm it matches
    const recordData: Record<string, unknown> = {
      record_id: record.record_id,
      namespace: record.namespace,
      event_type: record.event_type,
      prev_hash: record.prev_hash,
      actor: record.actor,
      timestamp: record.timestamp,
      payload: record.payload,
    };
    if (record.metadata) {
      recordData.metadata = record.metadata;
    }

    const encoder = new TextEncoder();
    const recordBytes = encoder.encode(JSON.stringify(recordData));
    const expectedHash = await computeHash(record.prev_hash, recordBytes);

    expect(record.hash).toBe(expectedHash);
  });
});
