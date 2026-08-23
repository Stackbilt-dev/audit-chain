# Evaluation receipt Worker

This example composes `@stackbilt/evals` with `@stackbilt/audit-chain`:

1. A private eval run is reduced to a public-safe `EvaluationReceiptArtifact`.
2. The artifact digest is verified before storage.
3. A one-record audit namespace is written for the receipt.
4. The returned chain head and expected record count make deletion, replacement,
   and payload tampering detectable during verification.

Install both packages in a Cloudflare Worker:

```bash
npm install @stackbilt/evals @stackbilt/audit-chain
```

The example uses one namespace per receipt (`evaluation-receipt:<receipt_id>`).
That avoids concurrent-writer branches without requiring a Durable Object. A
longitudinal chain such as `evaluation:<agent-name>` must serialize appends with
a Durable Object or another single-writer coordinator.

For storage-level retention, configure an R2 bucket lock for the `audit/`
prefix. Hash chaining detects tampering; a bucket lock prevents overwrite and
deletion for the configured retention period. They are complementary controls.

