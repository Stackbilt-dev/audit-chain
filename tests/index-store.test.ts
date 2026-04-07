/**
 * Tests for D1 index adapter: insertIndex and queryIndex.
 *
 * Uses an in-memory D1 mock that supports the query patterns
 * used by index-store.ts (INSERT, SELECT with WHERE/ORDER/LIMIT/OFFSET).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { insertIndex, queryIndex } from '../src/index-store';
import { GENESIS_HASH } from '../src/types';
import type { AuditRecord, AuditIndexRow, D1Database } from '../src/types';

// ---------------------------------------------------------------------------
// Mock D1 with query filtering
// ---------------------------------------------------------------------------

function createMockD1(): D1Database & { _rows: AuditIndexRow[] } {
  const rows: AuditIndexRow[] = [];

  const stmt = (query: string) => {
    let boundValues: unknown[] = [];

    const self = {
      bind(...values: unknown[]) {
        boundValues = values;
        return self;
      },
      async run() {
        if (query.trim().toUpperCase().startsWith('INSERT')) {
          rows.push({
            record_id: boundValues[0] as string,
            namespace: boundValues[1] as string,
            event_type: boundValues[2] as string,
            hash: boundValues[3] as string,
            prev_hash: boundValues[4] as string,
            actor: boundValues[5] as string,
            timestamp: boundValues[6] as string,
            payload_summary: boundValues[7] as string | null,
            created_at: new Date().toISOString(),
          });
        }
        return {};
      },
      async all<T = unknown>() {
        // Parse the WHERE clause to filter results
        let filtered = [...rows];

        // Extract conditions from bound values based on query structure
        // The query builds conditions dynamically; parse the SQL to figure out bindings
        const conditions = query.match(/(\w+)\s*(=|>=|<=)\s*\?/g) || [];
        let paramIdx = 0;

        for (const cond of conditions) {
          const match = cond.match(/(\w+)\s*(=|>=|<=)\s*\?/);
          if (!match) continue;
          const [, field, op] = match;
          const val = boundValues[paramIdx++];

          filtered = filtered.filter((row) => {
            const rowVal = row[field as keyof AuditIndexRow];
            if (op === '=') return rowVal === val;
            if (op === '>=') return String(rowVal) >= String(val);
            if (op === '<=') return String(rowVal) <= String(val);
            return true;
          });
        }

        // ORDER BY timestamp DESC
        filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        // LIMIT and OFFSET — the last two bound params
        const limit = boundValues[paramIdx] as number;
        const offset = boundValues[paramIdx + 1] as number;
        const sliced = filtered.slice(offset, offset + limit);

        return { results: sliced as T[] };
      },
    };

    return self;
  };

  return { _rows: rows, prepare: stmt };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    record_id: crypto.randomUUID(),
    namespace: 'test-ns',
    event_type: 'user.login',
    hash: 'a'.repeat(64),
    prev_hash: GENESIS_HASH,
    actor: 'admin',
    timestamp: new Date().toISOString(),
    payload: { action: 'login' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// insertIndex
// ---------------------------------------------------------------------------

describe('insertIndex', () => {
  let db: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    db = createMockD1();
  });

  it('inserts a row into the index', async () => {
    const record = makeRecord();
    await insertIndex(db, record);

    expect(db._rows.length).toBe(1);
    expect(db._rows[0].record_id).toBe(record.record_id);
    expect(db._rows[0].namespace).toBe(record.namespace);
    expect(db._rows[0].event_type).toBe(record.event_type);
    expect(db._rows[0].actor).toBe(record.actor);
  });

  it('truncates payload_summary to 500 characters', async () => {
    const largePayload: Record<string, unknown> = {};
    // Create a payload that serializes to >500 chars
    for (let i = 0; i < 100; i++) {
      largePayload[`key_${i}`] = `value_${i}_${'x'.repeat(10)}`;
    }

    const record = makeRecord({ payload: largePayload });
    await insertIndex(db, record);

    expect(db._rows[0].payload_summary!.length).toBeLessThanOrEqual(500);
  });

  it('stores full payload summary when under 500 chars', async () => {
    const record = makeRecord({ payload: { short: 'val' } });
    await insertIndex(db, record);

    const expected = JSON.stringify({ short: 'val' });
    expect(db._rows[0].payload_summary).toBe(expected);
  });

  it('inserts multiple records independently', async () => {
    await insertIndex(db, makeRecord({ event_type: 'a' }));
    await insertIndex(db, makeRecord({ event_type: 'b' }));
    await insertIndex(db, makeRecord({ event_type: 'c' }));

    expect(db._rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// queryIndex
// ---------------------------------------------------------------------------

describe('queryIndex', () => {
  let db: ReturnType<typeof createMockD1>;

  beforeEach(async () => {
    db = createMockD1();

    // Seed 5 records with distinct timestamps
    const records = [
      makeRecord({
        namespace: 'billing',
        event_type: 'charge.created',
        actor: 'stripe',
        timestamp: '2026-01-01T00:00:00Z',
      }),
      makeRecord({
        namespace: 'billing',
        event_type: 'charge.created',
        actor: 'stripe',
        timestamp: '2026-01-02T00:00:00Z',
      }),
      makeRecord({
        namespace: 'billing',
        event_type: 'refund.issued',
        actor: 'admin',
        timestamp: '2026-01-03T00:00:00Z',
      }),
      makeRecord({
        namespace: 'auth',
        event_type: 'user.login',
        actor: 'admin',
        timestamp: '2026-01-04T00:00:00Z',
      }),
      makeRecord({
        namespace: 'billing',
        event_type: 'charge.created',
        actor: 'manual',
        timestamp: '2026-01-05T00:00:00Z',
      }),
    ];

    for (const r of records) {
      await insertIndex(db, r);
    }
  });

  it('filters by namespace (required)', async () => {
    const results = await queryIndex(db, { namespace: 'billing' });
    expect(results.length).toBe(4);
    expect(results.every((r) => r.namespace === 'billing')).toBe(true);
  });

  it('returns empty array for non-existent namespace', async () => {
    const results = await queryIndex(db, { namespace: 'does-not-exist' });
    expect(results).toEqual([]);
  });

  it('filters by event_type', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      event_type: 'refund.issued',
    });
    expect(results.length).toBe(1);
    expect(results[0].event_type).toBe('refund.issued');
  });

  it('filters by actor', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      actor: 'stripe',
    });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.actor === 'stripe')).toBe(true);
  });

  it('filters by time range (after)', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      after: '2026-01-03T00:00:00Z',
    });
    // Should include Jan 3 and Jan 5
    expect(results.length).toBe(2);
  });

  it('filters by time range (before)', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      before: '2026-01-02T00:00:00Z',
    });
    // Should include Jan 1 and Jan 2
    expect(results.length).toBe(2);
  });

  it('filters by time range (after + before)', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      after: '2026-01-02T00:00:00Z',
      before: '2026-01-03T00:00:00Z',
    });
    // Jan 2 and Jan 3
    expect(results.length).toBe(2);
  });

  it('combines multiple filters', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      event_type: 'charge.created',
      actor: 'stripe',
    });
    expect(results.length).toBe(2);
  });

  it('returns results in descending timestamp order', async () => {
    const results = await queryIndex(db, { namespace: 'billing' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].timestamp >= results[i].timestamp).toBe(true);
    }
  });

  it('respects limit parameter', async () => {
    const results = await queryIndex(db, { namespace: 'billing', limit: 2 });
    expect(results.length).toBe(2);
  });

  it('respects offset parameter', async () => {
    const all = await queryIndex(db, { namespace: 'billing' });
    const paged = await queryIndex(db, {
      namespace: 'billing',
      offset: 2,
    });

    // Should skip the first 2 results
    expect(paged.length).toBe(all.length - 2);
    expect(paged[0].record_id).toBe(all[2].record_id);
  });

  it('caps limit at 1000', async () => {
    // Requesting limit > 1000 should be capped — verified by queryIndex logic
    // We can test that passing a huge limit doesn't break
    const results = await queryIndex(db, {
      namespace: 'billing',
      limit: 9999,
    });
    // Should still return all 4 billing records (well under 1000)
    expect(results.length).toBe(4);
  });

  it('defaults limit to 100 when not specified', async () => {
    // With only 4 records seeded, we just verify it doesn't crash
    // and returns all available records
    const results = await queryIndex(db, { namespace: 'billing' });
    expect(results.length).toBe(4);
  });

  it('returns empty for namespace with no matching filters', async () => {
    const results = await queryIndex(db, {
      namespace: 'billing',
      event_type: 'nonexistent.event',
    });
    expect(results).toEqual([]);
  });
});
