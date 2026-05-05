# audit-chain

Tamper-evident audit trail for Cloudflare Workers in under 200 lines of core logic.

SHA-256 hash chaining with R2 immutability and D1 indexing. Zero production dependencies -- uses only the Web Crypto API and Cloudflare bindings.

## Why Hash Chaining

Every audit record includes a SHA-256 hash computed from the previous record's hash concatenated with the current record's content. This means:

- **Tamper detection** -- modifying or deleting any record breaks the chain from that point forward.
- **Forensic integrity** -- the chain can be independently verified at any time.
- **Compliance** -- provides a cryptographic proof of record ordering and completeness.

R2 is the immutable source of truth. D1 is a searchable index. If D1 is wiped, the chain in R2 remains intact and verifiable.

## How It Works

```
Record 1                Record 2                Record 3
+-----------------+     +-----------------+     +-----------------+
| prev: GENESIS   |     | prev: hash_1    |     | prev: hash_2    |
| data: {...}     |---->| data: {...}     |---->| data: {...}     |
| hash: hash_1    |     | hash: hash_2    |     | hash: hash_3    |
+-----------------+     +-----------------+     +-----------------+

hash_N = SHA-256(prev_hash_bytes + JSON.stringify(record_data_bytes))
```

The genesis hash is 64 hex zeros (`000...000`). Each subsequent hash chains to the previous one. Verification walks the chain and recomputes every hash.

## Quick Start

### 1. Install

```bash
npm install @stackbilt/audit-chain
```

### 2. Create the D1 table

Run the migration against your D1 database:

```bash
npx wrangler d1 execute YOUR_DB --remote --file=node_modules/@stackbilt/audit-chain/schema.sql
```

Or copy `schema.sql` into your migrations directory.

### 3. Configure bindings

In your `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "AUDIT_BUCKET"
bucket_name = "your-audit-bucket"

[[d1_databases]]
binding = "AUDIT_DB"
database_name = "your-database"
database_id = "your-database-id"
```

### 4. Write records

```typescript
import { writeRecord, GENESIS_HASH } from '@stackbilt/audit-chain';
import type { AuditBindings } from '@stackbilt/audit-chain';

// Your chain head -- persist this (e.g., in a Durable Object or KV).
// Start with GENESIS_HASH for a new chain.
let chainHead = GENESIS_HASH;

const bindings: AuditBindings = {
  AUDIT_BUCKET: env.AUDIT_BUCKET,
  AUDIT_DB: env.AUDIT_DB,
};

const { record, newChainHead } = await writeRecord(bindings, {
  namespace: 'orders',
  chainHead,
  event_type: 'order.placed',
  actor: 'user:alice',
  payload: { order_id: 'ord_123', total: 99.99 },
  metadata: { ip: '203.0.113.1' },
});

chainHead = newChainHead;  // Persist this for the next write
```

### 5. Verify the chain

```typescript
import { verifyChain } from '@stackbilt/audit-chain';

const result = await verifyChain(bindings, 'orders');

if (!result.valid) {
  console.error(`Chain broken at record ${result.broken_at}: ${result.error}`);
}
```

### 6. Query the index

```typescript
import { queryIndex } from '@stackbilt/audit-chain';

const rows = await queryIndex(env.AUDIT_DB, {
  namespace: 'orders',
  event_type: 'order.placed',
  after: '2025-01-01T00:00:00Z',
  limit: 50,
});
```

## API Reference

### `writeRecord(bindings, opts)`

Write a new audit record to R2 and index it in D1.

| Parameter | Type | Description |
|-----------|------|-------------|
| `bindings` | `AuditBindings` | R2 bucket and D1 database bindings |
| `opts.namespace` | `string` | Chain namespace for isolation |
| `opts.chainHead` | `string` | Current chain head hash |
| `opts.event_type` | `string` | Application-defined event type |
| `opts.actor` | `string` | Who or what caused the event |
| `opts.payload` | `Record<string, unknown>` | Event data |
| `opts.metadata` | `Record<string, unknown>` | Optional metadata |

Returns `{ record: AuditRecord, newChainHead: string }`.

Throws if R2 or D1 writes fail. **If audit write fails, the audited action must not proceed.**

### `verifyChain(bindings, namespace)`

Verify the hash chain integrity for an entire namespace. Walks every record in timestamp order and recomputes each hash.

Returns `VerificationResult`:
- `valid: boolean` -- whether the chain is intact
- `record_count: number` -- total records checked
- `broken_at?: string` -- the record_id where the break was detected
- `error?: string` -- human-readable failure description

### `getRecord(bindings, namespace, recordId)`

Retrieve a single record from R2 by namespace and record ID. Returns `AuditRecord | null`.

### `getRecords(bindings, namespace)`

Retrieve all records for a namespace from R2, sorted by timestamp ascending. Returns `AuditRecord[]`.

### `queryIndex(db, opts)`

Query the D1 index with filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `db` | `D1Database` | D1 database binding |
| `opts.namespace` | `string` | Required -- chain namespace |
| `opts.event_type` | `string` | Filter by event type |
| `opts.actor` | `string` | Filter by actor |
| `opts.after` | `string` | ISO 8601 lower bound |
| `opts.before` | `string` | ISO 8601 upper bound |
| `opts.limit` | `number` | Max results (default 100, max 1000) |
| `opts.offset` | `number` | Pagination offset |

Returns `AuditIndexRow[]`.

### `computeHash(prevHash, recordBytes)`

Low-level: compute a single SHA-256 chain link. You probably don't need this directly.

### `GENESIS_HASH`

The chain genesis sentinel: 64 hex zeros. Use this as the initial `chainHead` for a new chain.

## Integrations

### Evidence Engine

`@stackbilt/evidence-core` produces content quality decisions; `audit-chain` makes them provable. Together they form a verifiable content governance trail.

Evidence Engine does not just score content — it creates a verifiable trail of how content earned publish approval.

#### Usage Example

```typescript
import { validateEvidence } from '@stackbilt/evidence-core';
import { toAuditPayload } from '@stackbilt/evidence-core/audit';
import { writeRecord, getChainHead } from '@stackbilt/audit-chain';

const result = validateEvidence(content, { policyVersion: 'google_march_2024_core' });
const record = toAuditPayload(result, {
  contentId,
  namespace: `tenant:${tenantId}:content:${contentId}`,
  contentHash: sha256(content),
});
const chainHead = await getChainHead(bindings, record.namespace);
await writeRecord(bindings, { ...record, chainHead });
```

#### Canonical Event Types

Evidence domain events for use in `event_type`:

- `evidence.validation.completed` — emitted by `toAuditPayload()` after validation runs
- `evidence.assets.merged` — emitted by `toAssetsAuditPayload()` when asset groups merge
- `evidence.validation.started` — consumer workflow: validation phase begins
- `evidence.gaps.detected` — consumer workflow: missing signals identified
- `evidence.redraft.completed` — consumer workflow: content revision finished
- `evidence.approval.granted` — consumer workflow: human or policy approves publish
- `evidence.publish.allowed` — consumer workflow: all gates clear, publish is permitted
- `evidence.publish.blocked` — consumer workflow: one or more gates failed

#### Canonical Namespace Patterns

Recommended namespace patterns for evidence trails:

- `content:{contentId}` — single piece of content
- `site:{siteId}:content:{contentId}` — content scoped to a site
- `tenant:{tenantId}:content:{contentId}` — multi-tenant organization

No direct dependency between the packages — consumers wire them at the application layer. See `audit-chain#2` for full event namespace specification.

## Examples

| Example | Description |
|---|---|
| [`examples/evidence-engine/`](examples/evidence-engine/) | Cloudflare Worker wiring audit-chain with `@stackbilt/evidence-core` for provable content governance |

## D1 Schema

```sql
CREATE TABLE IF NOT EXISTS audit_index (
  record_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  event_type TEXT NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_namespace ON audit_index(namespace);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_index(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_index(actor);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_index(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_ns_ts ON audit_index(namespace, timestamp);
```

## Chain Head Management

This library does not manage the chain head for you. You must persist the `newChainHead` returned by `writeRecord()` and pass it back on the next write. Good options:

- **Durable Object storage** -- single-writer guarantee, no race conditions (recommended)
- **KV** -- works if writes are serialized
- **D1 row** -- query the latest hash from the index as fallback

If you lose the chain head, you can reconstruct it by reading the most recent record from R2 and using its hash.

## Design Principles

- **R2 is truth, D1 is convenience.** If they diverge, R2 wins.
- **Append-only.** There is no update or delete operation.
- **Fail loud.** If the audit write fails, the caller is expected to abort the audited operation.
- **Namespace isolation.** Multiple independent chains can coexist in the same R2 bucket and D1 table.
- **Zero dependencies.** Only Web Crypto API and Cloudflare bindings.

## License

Apache-2.0
