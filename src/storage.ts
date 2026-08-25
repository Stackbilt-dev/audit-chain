/**
 * R2 storage adapter.
 *
 * R2 is the durable source of truth for audit records. Storage-level retention
 * requires a bucket lock configured by the consumer.
 * Path format: audit/{namespace}/{recordId}.json
 */

import type { AuditRecord, R2Bucket } from './types.js';

/**
 * Build the R2 key for a record.
 */
function r2Key(namespace: string, recordId: string): string {
  return `audit/${namespace}/${recordId}.json`;
}

/**
 * Write an audit record to R2.
 *
 * Sets content-type and custom metadata for operational visibility.
 */
export async function writeToR2(
  bucket: R2Bucket,
  namespace: string,
  record: AuditRecord
): Promise<void> {
  const key = r2Key(namespace, record.record_id);
  await bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      namespace,
      event_type: record.event_type,
      hash: record.hash,
    },
  });
}

/**
 * Read a single record from R2 by namespace + record ID.
 */
export async function readFromR2(
  bucket: R2Bucket,
  namespace: string,
  recordId: string
): Promise<AuditRecord | null> {
  const obj = await bucket.get(r2Key(namespace, recordId));
  if (!obj) return null;
  const text = await obj.text();
  return JSON.parse(text) as AuditRecord;
}

/**
 * List all records in a namespace from R2, sorted by timestamp ascending.
 *
 * R2 `list()` returns at most 1000 keys per call and signals more with
 * `truncated`/`cursor`. This walks every page: a single unpaginated call
 * silently drops each record past the first page, leaving `verifyChain()`
 * to run against a partial chain.
 */
export async function listByNamespace(
  bucket: R2Bucket,
  namespace: string
): Promise<AuditRecord[]> {
  const prefix = `audit/${namespace}/`;

  const records: AuditRecord[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list(cursor ? { prefix, cursor } : { prefix });

    for (const object of listed.objects) {
      const obj = await bucket.get(object.key);
      if (obj) {
        const text = await obj.text();
        records.push(JSON.parse(text) as AuditRecord);
      }
    }

    // A truncated page without a cursor would loop forever; treat it as the end.
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return records;
}
