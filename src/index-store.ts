/**
 * D1 index adapter.
 *
 * The D1 table is a searchable index — not the source of truth.
 * Full records live in R2. The index stores a truncated payload summary
 * for quick lookups without hitting R2.
 */

import type {
  AuditRecord,
  AuditIndexRow,
  D1Database,
  QueryOptions,
} from './types';

/** Maximum length for the payload_summary column. */
const SUMMARY_MAX_LENGTH = 500;

/**
 * Insert an audit record into the D1 index.
 */
export async function insertIndex(
  db: D1Database,
  record: AuditRecord
): Promise<void> {
  const payloadSummary = JSON.stringify(record.payload).slice(
    0,
    SUMMARY_MAX_LENGTH
  );

  await db
    .prepare(
      `INSERT INTO audit_index
       (record_id, namespace, event_type, hash, prev_hash, actor, timestamp, payload_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.record_id,
      record.namespace,
      record.event_type,
      record.hash,
      record.prev_hash,
      record.actor,
      record.timestamp,
      payloadSummary
    )
    .run();
}

/**
 * Query the audit index with optional filters.
 *
 * Supports filtering by namespace (required), event_type, actor,
 * and time range. Results are ordered by timestamp descending.
 */
export async function queryIndex(
  db: D1Database,
  opts: QueryOptions
): Promise<AuditIndexRow[]> {
  const conditions: string[] = ['namespace = ?'];
  const params: unknown[] = [opts.namespace];

  if (opts.event_type) {
    conditions.push('event_type = ?');
    params.push(opts.event_type);
  }
  if (opts.actor) {
    conditions.push('actor = ?');
    params.push(opts.actor);
  }
  if (opts.after) {
    conditions.push('timestamp >= ?');
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push('timestamp <= ?');
    params.push(opts.before);
  }

  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;

  const sql = `
    SELECT record_id, namespace, event_type, hash, prev_hash, actor, timestamp, payload_summary, created_at
    FROM audit_index
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<AuditIndexRow>();

  return results;
}
