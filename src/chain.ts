/**
 * Core hash chain logic.
 *
 * SHA-256(prev_hash_bytes + record_bytes) forms the chain link.
 * Uses the Web Crypto API — zero external dependencies.
 */

import type { AuditRecord, AuditBindings, VerificationResult } from './types';
import { GENESIS_HASH } from './types';
import { writeToR2, readFromR2, listByNamespace } from './storage';
import { insertIndex } from './index-store';

/**
 * Compute a SHA-256 chain link.
 *
 * Concatenates the UTF-8 bytes of `prevHash` with `recordBytes`,
 * then returns the hex-encoded SHA-256 digest.
 */
export async function computeHash(
  prevHash: string,
  recordBytes: Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  const prevBytes = encoder.encode(prevHash);

  const combined = new Uint8Array(prevBytes.length + recordBytes.length);
  combined.set(prevBytes, 0);
  combined.set(recordBytes, prevBytes.length);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Write a new audit record.
 *
 * 1. Builds the record (without hash)
 * 2. Serializes and computes the chain hash
 * 3. Writes the full record to R2 (immutable source of truth)
 * 4. Indexes a summary row in D1
 *
 * Returns the complete record and the new chain head hash.
 *
 * @throws if R2 or D1 writes fail — the caller must handle this.
 *   If audit write fails, the audited action MUST NOT proceed.
 */
export async function writeRecord(
  bindings: AuditBindings,
  opts: {
    namespace: string;
    chainHead: string;
    event_type: string;
    actor: string;
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<{ record: AuditRecord; newChainHead: string }> {
  const recordId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const prevHash = opts.chainHead || GENESIS_HASH;

  // Build record data (without hash — computed next)
  const recordData = {
    record_id: recordId,
    namespace: opts.namespace,
    event_type: opts.event_type,
    prev_hash: prevHash,
    actor: opts.actor,
    timestamp,
    payload: opts.payload,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };

  // Serialize for hashing
  const encoder = new TextEncoder();
  const recordBytes = encoder.encode(JSON.stringify(recordData));

  // Compute chain link
  const hash = await computeHash(prevHash, recordBytes);

  const record: AuditRecord = {
    ...recordData,
    hash,
  };

  // 1. Write to R2 (immutable source of truth)
  await writeToR2(bindings.AUDIT_BUCKET, opts.namespace, record);

  // 2. Index in D1
  await insertIndex(bindings.AUDIT_DB, record);

  return { record, newChainHead: hash };
}

/**
 * Retrieve a single record by ID from R2.
 */
export async function getRecord(
  bindings: AuditBindings,
  namespace: string,
  recordId: string
): Promise<AuditRecord | null> {
  return readFromR2(bindings.AUDIT_BUCKET, namespace, recordId);
}

/**
 * Retrieve all records for a namespace from R2, sorted by timestamp.
 */
export async function getRecords(
  bindings: AuditBindings,
  namespace: string
): Promise<AuditRecord[]> {
  return listByNamespace(bindings.AUDIT_BUCKET, namespace);
}

/**
 * Verify the hash chain integrity for an entire namespace.
 *
 * Walks every record in timestamp order and recomputes each hash
 * from its prev_hash + serialized record data. If any computed hash
 * does not match the stored hash, the chain is broken.
 */
export async function verifyChain(
  bindings: AuditBindings,
  namespace: string
): Promise<VerificationResult> {
  const records = await listByNamespace(bindings.AUDIT_BUCKET, namespace);

  if (records.length === 0) {
    return { valid: true, record_count: 0 };
  }

  const encoder = new TextEncoder();

  for (const record of records) {
    // Rebuild record data without the hash field
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

    const recordBytes = encoder.encode(JSON.stringify(recordData));
    const expectedHash = await computeHash(record.prev_hash, recordBytes);

    if (expectedHash !== record.hash) {
      return {
        valid: false,
        record_count: records.length,
        broken_at: record.record_id,
        error: `Hash mismatch at record ${record.record_id}: expected ${expectedHash}, got ${record.hash}`,
      };
    }
  }

  return { valid: true, record_count: records.length };
}
