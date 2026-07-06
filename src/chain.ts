/**
 * Core hash chain logic.
 *
 * SHA-256(prev_hash_bytes + record_bytes) forms the chain link.
 * Uses the Web Crypto API — zero external dependencies.
 */

import type {
  AuditRecord,
  AuditBindings,
  VerificationOptions,
  VerificationResult,
} from './types.js';
import { GENESIS_HASH } from './types.js';
import { writeToR2, readFromR2, listByNamespace } from './storage.js';
import { insertIndex } from './index-store.js';

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
 * Recomputes each hash from its prev_hash + serialized record data,
 * then verifies that the records form one connected, unbranched path
 * from GENESIS_HASH to the terminal chain head.
 */
export async function verifyChain(
  bindings: AuditBindings,
  namespace: string,
  opts: VerificationOptions = {}
): Promise<VerificationResult> {
  const records = await listByNamespace(bindings.AUDIT_BUCKET, namespace);

  if (records.length === 0) {
    if (opts.expectedRecordCount !== undefined && opts.expectedRecordCount !== 0) {
      return {
        valid: false,
        record_count: 0,
        error: `Record count mismatch: expected ${opts.expectedRecordCount}, got 0`,
      };
    }
    if (
      opts.expectedChainHead !== undefined &&
      opts.expectedChainHead !== GENESIS_HASH
    ) {
      return {
        valid: false,
        record_count: 0,
        error: `Chain head mismatch: expected ${opts.expectedChainHead}, got ${GENESIS_HASH}`,
      };
    }
    return { valid: true, record_count: 0 };
  }

  const encoder = new TextEncoder();
  const recordsByHash = new Map<string, AuditRecord>();

  for (const record of records) {
    if (recordsByHash.has(record.hash)) {
      return {
        valid: false,
        record_count: records.length,
        broken_at: record.record_id,
        error: `Duplicate hash at record ${record.record_id}: ${record.hash}`,
      };
    }
    recordsByHash.set(record.hash, record);

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

  let genesisRecord: AuditRecord | undefined;
  const childByPrevHash = new Map<string, AuditRecord>();

  for (const record of records) {
    if (record.prev_hash === GENESIS_HASH) {
      if (genesisRecord) {
        return {
          valid: false,
          record_count: records.length,
          broken_at: record.record_id,
          error: `Multiple genesis records: ${genesisRecord.record_id} and ${record.record_id}`,
        };
      }
      genesisRecord = record;
    } else if (!recordsByHash.has(record.prev_hash)) {
      return {
        valid: false,
        record_count: records.length,
        broken_at: record.record_id,
        error: `Missing previous record for ${record.record_id}: prev_hash ${record.prev_hash} was not found`,
      };
    }

    const existingChild = childByPrevHash.get(record.prev_hash);
    if (existingChild) {
      return {
        valid: false,
        record_count: records.length,
        broken_at: record.record_id,
        error: `Branch detected at prev_hash ${record.prev_hash}: records ${existingChild.record_id} and ${record.record_id}`,
      };
    }
    childByPrevHash.set(record.prev_hash, record);
  }

  if (!genesisRecord) {
    return {
      valid: false,
      record_count: records.length,
      broken_at: records[0].record_id,
      error: 'Missing genesis record',
    };
  }

  const visitedHashes = new Set<string>();
  let current: AuditRecord | undefined = genesisRecord;
  let terminalRecord = genesisRecord;

  while (current) {
    if (visitedHashes.has(current.hash)) {
      return {
        valid: false,
        record_count: records.length,
        broken_at: current.record_id,
        error: `Cycle detected at record ${current.record_id}`,
      };
    }

    visitedHashes.add(current.hash);
    terminalRecord = current;
    current = childByPrevHash.get(current.hash);
  }

  if (visitedHashes.size !== records.length) {
    const disconnected = records.find((record) => !visitedHashes.has(record.hash));
    return {
      valid: false,
      record_count: records.length,
      broken_at: disconnected?.record_id,
      error: 'Disconnected chain segment detected',
    };
  }

  if (
    opts.expectedRecordCount !== undefined &&
    opts.expectedRecordCount !== records.length
  ) {
    return {
      valid: false,
      record_count: records.length,
      broken_at: terminalRecord.record_id,
      error: `Record count mismatch: expected ${opts.expectedRecordCount}, got ${records.length}`,
    };
  }

  if (
    opts.expectedChainHead !== undefined &&
    opts.expectedChainHead !== terminalRecord.hash
  ) {
    return {
      valid: false,
      record_count: records.length,
      broken_at: terminalRecord.record_id,
      error: `Chain head mismatch: expected ${opts.expectedChainHead}, got ${terminalRecord.hash}`,
    };
  }

  return { valid: true, record_count: records.length };
}
