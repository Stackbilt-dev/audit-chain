# Example: Evidence Engine Worker

Demonstrates wiring `@stackbilt/evidence-core` and `@stackbilt/audit-chain` together in a Cloudflare Worker. Every content validation run produces a tamper-evident chain entry — creating a provable record of how content earned (or failed to earn) publish approval.

## What it does

| Endpoint | Description |
|---|---|
| `POST /validate` | Validate content quality; write audit record |
| `GET /chain/:namespace` | Retrieve full audit chain for a namespace |
| `GET /verify/:namespace` | Verify chain integrity |

## Integration pattern

`evidence-core` and `audit-chain` have no dependency on each other. The adapter in `@stackbilt/evidence-core/audit` produces an `EvidenceAuditRecord` that is shape-compatible with `writeRecord()`:

```ts
const result = validateEvidence(content, { policyVersion });
const record = toAuditPayload(result, { contentId, namespace });
const chainHead = await getChainHead(env, namespace);
const { record: auditRecord } = await writeRecord(env, { ...record, chainHead });
```

`getChainHead` is not exported from audit-chain — implement it from `getRecords`:

```ts
async function getChainHead(bindings, namespace) {
  const records = await getRecords(bindings, namespace);
  return records.length > 0 ? records[records.length - 1].hash : GENESIS_HASH;
}
```

## Cloudflare bindings

Add to your `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "AUDIT_BUCKET"
bucket_name = "your-audit-bucket"

[[d1_databases]]
binding = "AUDIT_DB"
database_name = "your-audit-db"
database_id = "your-database-id"
```

Run the D1 schema migration before first use:

```bash
npx wrangler d1 execute your-audit-db --remote --file=../../schema.sql
```

## Namespace conventions

| Pattern | Use case |
|---|---|
| `content:{contentId}` | Single-tenant |
| `site:{siteId}:content:{contentId}` | Multi-site |
| `tenant:{tenantId}:content:{contentId}` | Multi-tenant SaaS |

## Canonical event types

Events emitted by this example:

| Event type | Emitted by |
|---|---|
| `evidence.validation.completed` | `toAuditPayload()` |
| `evidence.assets.merged` | `toAssetsAuditPayload()` |

Consumer workflows emit the remaining events (`evidence.validation.started`, `evidence.gaps.detected`, `evidence.redraft.completed`, `evidence.approval.granted`, `evidence.publish.allowed`, `evidence.publish.blocked`) at appropriate points in their pipeline.

## Note on package availability

`@stackbilt/audit-chain` and `@stackbilt/evidence-core` are not yet published to npm. Import from local paths during development:

```ts
import { validateEvidence } from '../../node_modules/@stackbilt/evidence-core/dist/index.js';
```

Track publication status: [audit-chain#2](https://github.com/Stackbilt-dev/audit-chain/issues/2)
