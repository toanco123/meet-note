import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Test KIẾN TRÚC trên `openapi.json` (đã commit, CI kiểm tra khớp code): mọi response 2xx JSON đều
 * được mô tả là `{ data, meta }`, trừ route đánh dấu `x-raw-response` (health). Route danh sách
 * (`x-paginated`) có `data` là mảng và `meta` là `PaginatedMetaDto`.
 */
interface Operation {
  operationId: string;
  'x-raw-response'?: boolean;
  'x-paginated'?: boolean;
  responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
interface Schema {
  required?: string[];
  properties?: { data?: { type?: string }; meta?: { $ref?: string } };
}

const document = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, Operation>> };

const jsonSuccesses = Object.values(document.paths)
  .flatMap((item) => Object.values(item))
  .flatMap((op) =>
    Object.entries(op.responses)
      .filter(([status, res]) => status.startsWith('2') && res.content?.['application/json'])
      .map(([status, res]) => ({ op, status, schema: res.content?.['application/json']?.schema })),
  );

describe('openapi.json — envelope', () => {
  it('mọi response 2xx JSON (trừ raw) là { data, meta }', () => {
    const offenders = jsonSuccesses
      .filter(({ op }) => op['x-raw-response'] !== true)
      .filter(({ schema }) => schema?.required?.join() !== 'data,meta')
      .map(({ op, status }) => `${op.operationId} ${status}`);
    expect(offenders).toEqual([]);
  });

  it('route danh sách: data là mảng, meta là PaginatedMetaDto; còn lại meta là ResponseMetaDto', () => {
    const wrong = jsonSuccesses
      .filter(({ op }) => op['x-raw-response'] !== true)
      .filter(({ op, schema }) =>
        op['x-paginated'] === true
          ? schema?.properties?.data?.type !== 'array' ||
            !schema.properties.meta?.$ref?.endsWith('/PaginatedMetaDto')
          : !schema?.properties?.meta?.$ref?.endsWith('/ResponseMetaDto'),
      )
      .map(({ op }) => op.operationId);
    expect(wrong).toEqual([]);
  });

  it('route raw (health) giữ body thô', () => {
    const raw = jsonSuccesses.filter(({ op }) => op['x-raw-response'] === true);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.filter(({ schema }) => schema?.properties?.data !== undefined)).toEqual([]);
  });
});
