/**
 * audit-chain type definitions.
 *
 * Generic, domain-agnostic types for tamper-evident audit logging.
 */

/**
 * Chain genesis sentinel — 64 hex zeros.
 * The first record in any chain uses this as its prev_hash.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * An immutable audit record. Written to R2 as the source of truth,
 * indexed in D1 for queryability.
 *
 * The `hash` field is SHA-256(prev_hash_bytes + serialized_record_bytes),
 * forming a tamper-evident chain.
 */
export interface AuditRecord {
  /** Unique record identifier (UUIDv4). */
  record_id: string;
  /** Namespace for chain isolation — multiple chains can coexist. */
  namespace: string;
  /** Application-defined event type (e.g. "user.login", "order.placed"). */
  event_type: string;
  /** SHA-256 hash linking this record to the previous one. */
  hash: string;
  /** Hash of the previous record (or GENESIS_HASH for the first). */
  prev_hash: string;
  /** Who or what caused the event. */
  actor: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Arbitrary event payload. */
  payload: Record<string, unknown>;
  /** Optional metadata (tags, correlation IDs, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * The current head of a hash chain — the most recent hash
 * that the next record must link to.
 */
export interface ChainHead {
  namespace: string;
  hash: string;
}

/**
 * Result of a chain integrity verification.
 */
export interface VerificationResult {
  /** Whether every hash link in the chain is valid. */
  valid: boolean;
  /** Total records checked. */
  record_count: number;
  /** The record_id where the chain first broke, if any. */
  broken_at?: string;
  /** Human-readable description of the failure. */
  error?: string;
}

/**
 * Options for querying the audit index.
 */
export interface QueryOptions {
  namespace: string;
  event_type?: string;
  actor?: string;
  /** ISO 8601 lower bound (inclusive). */
  after?: string;
  /** ISO 8601 upper bound (inclusive). */
  before?: string;
  limit?: number;
  offset?: number;
}

/**
 * A row from the D1 audit index (excludes full payload).
 */
export interface AuditIndexRow {
  record_id: string;
  namespace: string;
  event_type: string;
  hash: string;
  prev_hash: string;
  actor: string;
  timestamp: string;
  payload_summary: string | null;
  created_at: string;
}

/**
 * Cloudflare R2 bucket binding (subset used by this library).
 */
export interface R2Bucket {
  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
  }>;
}

/**
 * Cloudflare D1 database binding (subset used by this library).
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/**
 * Bindings required by audit-chain.
 */
export interface AuditBindings {
  /** R2 bucket for immutable record storage. */
  AUDIT_BUCKET: R2Bucket;
  /** D1 database for the searchable index. */
  AUDIT_DB: D1Database;
}
