/**
 * Evidence Engine — end-to-end example Worker.
 *
 * Validates content against Google E-E-A-T policy and writes a
 * tamper-evident audit record for every validation run.
 *
 * POST /validate   { contentId, content, policyVersion? }
 * GET  /chain/:ns  Retrieve full audit chain for a namespace
 * GET  /verify/:ns Verify chain integrity for a namespace
 */

import { validateEvidence } from '@stackbilt/evidence-core';
import { toAuditPayload, toAssetsAuditPayload } from '@stackbilt/evidence-core/audit';
import {
  writeRecord,
  getRecords,
  verifyChain,
  GENESIS_HASH,
} from '@stackbilt/audit-chain';
import type { AuditBindings } from '@stackbilt/audit-chain';

// Env extends AuditBindings — wrangler injects AUDIT_BUCKET and AUDIT_DB
type Env = AuditBindings;

/** Returns the current chain head hash for a namespace, or GENESIS_HASH if empty. */
async function getChainHead(bindings: AuditBindings, namespace: string): Promise<string> {
  const records = await getRecords(bindings, namespace);
  return records.length > 0 ? records[records.length - 1].hash : GENESIS_HASH;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // POST /validate
    if (req.method === 'POST' && url.pathname === '/validate') {
      let body: { contentId: string; content: string; policyVersion?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }

      const { contentId, content, policyVersion } = body;
      if (!contentId || !content) {
        return Response.json({ error: 'contentId and content are required' }, { status: 400 });
      }

      // 1. Validate content quality
      const result = validateEvidence(
        { content },
        { policyVersion: policyVersion ?? 'google_march_2024_core' },
      );

      // 2. Build audit record (shape-compatible with writeRecord)
      const namespace = `content:${contentId}`;
      const record = toAuditPayload(result, { contentId, namespace });

      // 3. Get current chain head and write the audit record
      const chainHead = await getChainHead(env, namespace);
      const { record: auditRecord, newChainHead } = await writeRecord(env, {
        ...record,
        chainHead,
      });

      return Response.json({
        validation: {
          hasGaps: result.hasGaps,
          gapCount: result.gapCount,
          policyVersion: result.policyVersion,
          suggestions: result.suggestions,
        },
        audit: {
          record_id: auditRecord.record_id,
          namespace: auditRecord.namespace,
          event_type: auditRecord.event_type,
          hash: newChainHead,
          timestamp: auditRecord.timestamp,
        },
      });
    }

    // GET /chain/:namespace
    const chainMatch = url.pathname.match(/^\/chain\/(.+)$/);
    if (req.method === 'GET' && chainMatch) {
      const namespace = decodeURIComponent(chainMatch[1]);
      const records = await getRecords(env, namespace);
      return Response.json({ namespace, record_count: records.length, records });
    }

    // GET /verify/:namespace
    const verifyMatch = url.pathname.match(/^\/verify\/(.+)$/);
    if (req.method === 'GET' && verifyMatch) {
      const namespace = decodeURIComponent(verifyMatch[1]);
      const result = await verifyChain(env, namespace);
      return Response.json({ namespace, ...result });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
