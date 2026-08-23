# Changelog

All notable changes to `@stackbilt/audit-chain` will be documented here.

## [0.1.3] — 2026-08-23

### Added
- Evaluation receipt integration example for `@stackbilt/evals`

### Changed
- Clarified that hash chaining provides tamper evidence while R2 bucket locks provide retention enforcement
- Emitted ESM now uses explicit `.js` specifiers so the published package loads in standard Node ESM as well as Worker bundlers

## [0.1.0] — 2026-05-05

### Added
- SHA-256 hash chain core (`writeRecord`, `getRecord`, `getRecords`, `verifyChain`)
- R2 as immutable source of truth with D1 as searchable index
- `computeHash` using Web Crypto API — zero production dependencies
- `queryIndex` for filtered D1 queries (namespace, event_type, actor, time range)
- `GENESIS_HASH` sentinel for chain initialization
- Full TypeScript types: `AuditRecord`, `AuditBindings`, `ChainHead`, `VerificationResult`, `QueryOptions`, `AuditIndexRow`
- `examples/evidence-engine/` — Cloudflare Worker demonstrating integration with `@stackbilt/evidence-core`
