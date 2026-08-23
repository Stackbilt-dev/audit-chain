import {
  toEvaluationAuditEvent,
  verifyEvaluationReceiptArtifact,
  type EvaluationReceiptArtifact,
} from '@stackbilt/evals';
import {
  GENESIS_HASH,
  verifyChain,
  writeRecord,
  type AuditBindings,
} from '@stackbilt/audit-chain';

type Env = AuditBindings;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/receipts') {
      const artifact = await request.json<EvaluationReceiptArtifact>();
      if (!(await verifyEvaluationReceiptArtifact(artifact))) {
        return Response.json({ error: 'invalid evaluation receipt digest' }, { status: 400 });
      }

      const namespace = `evaluation-receipt:${artifact.receipt.receipt_id}`;
      const event = toEvaluationAuditEvent(artifact, {
        namespace,
        actor: 'ci:example',
      });
      const { record, newChainHead } = await writeRecord(env, {
        ...event,
        chainHead: GENESIS_HASH,
      });

      return Response.json({
        receipt_digest: artifact.digest,
        audit_record_id: record.record_id,
        namespace,
        chain_head: newChainHead,
        expected_record_count: 1,
      }, { status: 201 });
    }

    const match = url.pathname.match(/^\/verify\/([0-9a-f-]+)$/);
    if (request.method === 'GET' && match) {
      const expectedChainHead = url.searchParams.get('head');
      if (!expectedChainHead) {
        return Response.json({ error: 'head query parameter is required' }, { status: 400 });
      }

      const namespace = `evaluation-receipt:${match[1]}`;
      const result = await verifyChain(env, namespace, {
        expectedChainHead,
        expectedRecordCount: 1,
      });
      return Response.json({ namespace, ...result }, { status: result.valid ? 200 : 409 });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};

