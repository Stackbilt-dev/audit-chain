/**
 * @stackbilt/audit-chain
 *
 * Tamper-evident audit trail for Cloudflare Workers.
 * SHA-256 hash chaining with R2 immutability and D1 indexing.
 */

// Core operations
export { computeHash, writeRecord, getRecord, getRecords, verifyChain } from './chain';

// Index queries
export { queryIndex } from './index-store';

// Types
export type {
  AuditRecord,
  ChainHead,
  VerificationResult,
  QueryOptions,
  AuditIndexRow,
  AuditBindings,
  R2Bucket,
  D1Database,
  D1PreparedStatement,
} from './types';

// Constants
export { GENESIS_HASH } from './types';
