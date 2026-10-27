import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { transcriptSegments } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { insertMeeting } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** Sửa xong, tìm kiếm (M8) và xuất SRT / VTT thấy bản mới NGAY — không cần đồng bộ gì thêm (M13 B4). */
describe('Sửa transcript → search + export phản ánh (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  const http = () => request(app.getHttpServer());
  const as = () => bearer(owner.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    owner = await registerUser(app);
    orgId = (await http().post('/v1/orgs').set(as()).send({ name: 'Phản ánh' }).expect(201)).body
      .data.id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  async function meeting(title: string, ...texts: string[]): Promise<string> {
    const m = await insertMeeting(db, orgId, owner.id, { title, status: 'completed' });
    await db.insert(transcriptSegments).values(
      texts.map((text, seq) => ({
        meetingId: m.id,
        orgId,
        seq,
        startMs: seq * 1000,
        endMs: seq * 1000 + 900,
        text,
      })),
    );
    return m.id;
  }
  const search = async (q: string) =>
    (await http().get(`/v1/orgs/${orgId}/search/transcripts`).query({ q }).set(as()).expect(200))
      .body.data as Array<{ meetingId: string; hits: Array<{ seq: number; snippet: string }> }>;
  const exportFile = async (id: string, format: 'srt' | 'vtt') =>
    (
      await http()
        .get(`/v1/orgs/${orgId}/meetings/${id}/transcript/export`)
        .query({ format })
        .set(as())
        .buffer(true)
        .parse((res, cb) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => cb(null, body));
        })
        .expect(200)
    ).body as string;
  const edit = (id: string, seq: number, version: number, text: string) =>
    http()
      .patch(`/v1/orgs/${orgId}/meetings/${id}/transcript/segments/${seq}`)
      .set(as())
      .set('If-Match', `"${version}"`)
      .send({ text });

  it('từ khoá cũ không còn ra đoạn đó, từ khoá mới ra đúng đoạn; không dấu ra có dấu', async () => {
    // Từ riêng của test để không lẫn meeting của test khác trong cùng org.
    const id = await meeting(
      'Họp kiểm phản ánh',
      'chốt phương án zephyrnova tuần này',
      'đoạn khác',
    );
    expect((await search('zephyrnova')).map((r) => r.meetingId)).toEqual([id]);
    expect(await search('quillbright')).toEqual([]);

    await edit(id, 0, 1, 'chốt phương án quillbright tuần này').expect(200);

    expect(await search('zephyrnova')).toEqual([]); // từ cũ biến mất
    const found = await search('quillbright');
    expect(found.map((r) => r.meetingId)).toEqual([id]);
    expect(found[0]!.hits.map((h) => h.seq)).toEqual([0]);
    expect(found[0]!.hits[0]!.snippet).toContain('quillbright');
  });

  it('SRT / VTT chứa bản đã sửa, đoạn chưa sửa nguyên, mốc thời gian không đổi', async () => {
    const id = await meeting('Họp xuất bản sửa', 'kế hoạch quý ba', 'ngân sách marketing');
    await edit(id, 1, 1, 'ngân sách <b>kế toán</b> & hơn').expect(200);

    const srt = await exportFile(id, 'srt');
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:00,900\nkế hoạch quý ba\n\n' +
        '2\n00:00:01,000 --> 00:00:01,900\nngân sách <b>kế toán</b> & hơn\n\n',
    );
    const vtt = await exportFile(id, 'vtt');
    expect(vtt).toContain(
      '00:00:01.000 --> 00:00:01.900\nngân sách &lt;b&gt;kế toán&lt;/b&gt; &amp; hơn',
    );
    expect(vtt).toContain('kế hoạch quý ba');
    expect(vtt).not.toContain('ngân sách marketing');
  });

  it('sửa nhiều lần liên tiếp: search chỉ thấy bản CUỐI', async () => {
    const id = await meeting('Họp sửa nhiều lần', 'alphaone');
    await edit(id, 0, 1, 'betatwo').expect(200);
    await edit(id, 0, 2, 'gammathree').expect(200);
    expect(await search('alphaone')).toEqual([]);
    expect(await search('betatwo')).toEqual([]);
    expect((await search('gammathree')).map((r) => r.meetingId)).toEqual([id]);
  });
});
