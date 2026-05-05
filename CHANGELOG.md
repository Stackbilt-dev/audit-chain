# Changelog

All notable changes to `@stackbilt/audit-chain` will be documented here.

## [0.1.0] — 2026-05-05

### Added
- SHA-256 hash chain core (`writeRecord`, `getRecord`, `getRecords`, `verifyChain`)
- R2 as immutable source of truth with D1 as searchable index
- `computeHash` using Web Crypto API — zero production dependencies
- `queryIndex` for filtered D1 queries (namespace, event_type, actor, time range)
- `GENESIS_HASH` sentinel for chain initialization
- Full TypeScript types: `AuditRecord`, `AuditBindings`, `ChainHead`, `VerificationResult`, `QueryOptions`, `AuditIndexRow`
- `examples/evidence-engine/` — Cloudflare Worker demonstrating integration with `@stackbilt/evidence-core`
