/**
 * @stackbilt/audit-chain
 *
 * Tamper-evident audit trail for Cloudflare Workers.
 * SHA-256 hash chaining with R2 durable storage and D1 indexing.
 */

// Core operations
export { computeHash, writeRecord, getRecord, getRecords, verifyChain } from './chain.js';

// Index queries
export { queryIndex } from './index-store.js';

// Types
export type {
  AuditRecord,
  ChainHead,
  VerificationOptions,
  VerificationResult,
  QueryOptions,
  AuditIndexRow,
  AuditBindings,
  R2Bucket,
  D1Database,
  D1PreparedStatement,
} from './types.js';

// Constants
export { GENESIS_HASH } from './types.js';
