import http from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PG_POOL } from '../../../src/infra/database/database.module.js';
import { OrgContext } from '../../../src/infra/database/org-context.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { transcriptSegments } from '../../../src/infra/database/schema/index.js';
import type { OrgMembershipContext } from '../../../src/modules/organizations/organizations.types.js';
import { TranscriptsService } from '../../../src/modules/transcripts/transcripts.service.js';
import { TranscriptsRepository } from '../../../src/modules/transcripts/transcripts.repository.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { addMember, insertMeeting, insertOrg, insertUser } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { portOf } from '../../support/realtime.js';

/** Xuất SRT / VTT qua HTTP (M8 B4): stream theo lô, quyền xem, tên file, lỗi giữa chừng, client ngắt. */
describe('GET /orgs/:orgId/meetings/:meetingId/transcript/export (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let pool: Pool;
  let orgId: string;
  let owner: TestUser;
  let outsider: TestUser;
  const httpReq = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const url = (id: string, suffix = '?format=srt') =>
    `/v1/orgs/${orgId}/meetings/${id}/transcript/export${suffix}`;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    db = fixtureDb();
    pool = app.get<Pool>(PG_POOL);
    owner = await registerUser(app);
    outsider = await registerUser(app);
    orgId = (await httpReq().post('/v1/orgs').set(as(owner)).send({ name: 'Xuất' }).expect(201))
      .body.data.id as string;
    await addMember(db, orgId, outsider.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Meeting của `owner` (chỉ chủ xem được — `outsider` không thấy) với `n` đoạn. */
  async function meetingWith(
    n: number,
    opts: {
      title?: string;
      status?: 'completed' | 'summarizing';
      text?: (i: number) => string;
    } = {},
  ): Promise<string> {
    const m = await insertMeeting(db, orgId, owner.id, {
      title: opts.title ?? 'Họp xuất file',
      status: opts.status ?? 'completed',
    });
    const text = opts.text ?? ((i) => `Câu số ${i}`);
    for (let start = 0; start < n; start += 1000) {
      await db.insert(transcriptSegments).values(
        Array.from({ length: Math.min(1000, n - start) }, (_, k) => {
          const i = start + k;
          return {
            meetingId: m.id,
            orgId,
            seq: i,
            startMs: i * 1_000,
            endMs: i * 1_000 + 900,
            text: text(i),
          };
        }),
      );
    }
    return m.id;
  }
  const download = (id: string, user: TestUser, suffix?: string) =>
    httpReq()
      .get(url(id, suffix))
      .set(as(user))
      .buffer(true)
      .parse((res, cb) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => cb(null, body));
        res.on('error', (e) => cb(e, ''));
      });

  it('SRT: 1 200 đoạn (qua 3 lô) → đủ cue, đúng thứ tự, đúng header; VTT có WEBVTT, dấu chấm', async () => {
    const id = await meetingWith(1_200);
    const srt = await download(id, owner, '?format=srt').expect(200);
    const body = srt.body as string;
    const cues = body.split('\n\n').filter(Boolean);
    expect(cues).toHaveLength(1_200);
    expect(cues[0]).toBe('1\n00:00:00,000 --> 00:00:00,900\nCâu số 0');
    expect(cues[500]).toBe('501\n00:08:20,000 --> 00:08:20,900\nCâu số 500'); // biên lô thứ hai
    expect(cues[1_199]).toBe('1200\n00:19:59,000 --> 00:19:59,900\nCâu số 1199');
    expect(srt.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
    expect(srt.headers['content-disposition']).toBe(
      `attachment; filename="Hop xuat file.srt"; filename*=UTF-8''H%E1%BB%8Dp%20xu%E1%BA%A5t%20file.srt`,
    );
    expect(srt.headers['cache-control']).toBe('private, no-store');

    const vtt = (await download(id, owner, '?format=vtt').expect(200)).body as string;
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:00.900\nCâu số 0\n\n')).toBe(true);
    expect(vtt.split('\n\n').filter(Boolean)).toHaveLength(1_201);
  });

  // Đột biến: bỏ `runInOrg` quanh mỗi lô → nếu ngữ cảnh RLS mất thì file RỖNG (0 dòng, không lỗi).
  it('chuỗi độc trong transcript / tiêu đề: cue không vỡ, header không bị chèn', async () => {
    const id = await meetingWith(2, {
      title: 'Họp\r\nSet-Cookie: a=1; "x"',
      text: (i) => (i === 0 ? 'trước\n\nsau --> nữa <b>x</b> & y' : 'cue hai'),
    });
    const vtt = (await download(id, owner, '?format=vtt').expect(200)).body as string;
    const res = await download(id, owner, '?format=vtt');
    expect(vtt).toContain('trước\nsau --&gt; nữa &lt;b&gt;x&lt;/b&gt; &amp; y\n\n');
    expect(vtt.split('\n\n').filter(Boolean)).toHaveLength(3);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
    // Chỉ có MỘT cặp nháy quanh filename, mọi ký tự lạ đã thành `_` / khoảng trắng.
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Hop Set-Cookie [^"]*\.vtt"; filename\*=UTF-8''[^;\s]+$/,
    );
  });

  // Đột biến: bỏ `OrgContext.runInOrg` quanh mỗi lô → đọc ngoài ngữ cảnh request ra file RỖNG (RLS: 0
  // dòng, không lỗi). Luồng HTTP thật giữ được ngữ cảnh qua `await` nên đột biến này không lộ ở test
  // HTTP (đã thử: sống sót) — test này dựng đúng tình huống mà dòng bảo vệ đó nhắm tới.
  it('đọc stream NGOÀI ngữ cảnh org của request (RLS) vẫn ra đủ dữ liệu, không phải file rỗng', async () => {
    const id = await meetingWith(1_200);
    const download = await OrgContext.runInOrg(orgId, () =>
      app
        .get(TranscriptsService)
        .exportSubtitles({ orgId, role: 'member' } as OrgMembershipContext, owner.id, id, 'srt'),
    );
    // Đọc ở đây: ngoài `runInOrg` → không có ngữ cảnh nào.
    expect(OrgContext.current()).toBeNull();
    let body = '';
    for await (const chunk of download.stream) body += chunk as string;
    expect(body.split('\n\n').filter(Boolean)).toHaveLength(1_200);
  });

  it('quyền & validate: không xem được → 404; chưa xong → 409; format sai / thiếu / id lạ → 400; chưa đăng nhập → 401', async () => {
    const id = await meetingWith(3);
    const running = await meetingWith(3, { status: 'summarizing' });
    const status = async (req: request.Test) => (await req).status;
    expect([
      await status(httpReq().get(url(id)).set(as(outsider))),
      await status(httpReq().get(url(running)).set(as(owner))),
      await status(httpReq().get(url(id, '?format=docx')).set(as(owner))),
      await status(httpReq().get(url(id, '')).set(as(owner))),
      await status(httpReq().get(url('khong-phai-uuid')).set(as(owner))),
      await status(httpReq().get(url(id))),
    ]).toEqual([404, 409, 400, 400, 400, 401]);
  });

  it('meeting của org khác → 404 dù đúng id (không lộ tồn tại)', async () => {
    const stranger = await insertUser(db);
    const otherOrg = (await insertOrg(db, stranger.id)).id;
    const foreign = (await insertMeeting(db, otherOrg, stranger.id)).id;
    await httpReq().get(url(foreign)).set(as(owner)).expect(404);
  });

  // Đột biến: không bắt lỗi / không huỷ stream → response treo mãi (test hết giờ).
  it('lỗi DB ở lô thứ hai (headers đã gửi): response KẾT THÚC (cắt ngang), không treo, pool không rò', async () => {
    const id = await meetingWith(1_200);
    const repo = app.get(TranscriptsRepository);
    const original = repo.segmentBatch.bind(repo);
    let calls = 0;
    vi.spyOn(repo, 'segmentBatch').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('DB chết giữa chừng'));
      return original(...args);
    });
    const outcome = await Promise.race([
      download(id, owner)
        .then(() => 'ended')
        .catch(() => 'ended'),
      new Promise((resolve) => setTimeout(resolve, 8_000, 'treo')),
    ]);
    expect(outcome).toBe('ended');
    await vi.waitFor(() => expect(pool.totalCount - pool.idleCount).toBe(0), { timeout: 3_000 });
  });

  it('client NGẮT sau chunk đầu: ngừng đọc các lô sau, connection về pool', async () => {
    const id = await meetingWith(8_000, { text: (i) => `Câu số ${i} ${'x'.repeat(200)}` }); // 16 lô, ≈ 2 MB
    const repo = app.get(TranscriptsRepository);
    const spy = vi.spyOn(repo, 'segmentBatch');
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          port: portOf(app),
          path: url(id),
          headers: { authorization: `Bearer ${owner.tokens.accessToken}` },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
          res.on('error', () => undefined);
        },
      );
      req.on('error', (error) => (req.destroyed ? undefined : reject(error)));
    });
    await new Promise((r) => setTimeout(r, 500));
    const callsAfterAbort = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(spy.mock.calls.length).toBe(callsAfterAbort); // đã dừng hẳn
    expect(callsAfterAbort).toBeLessThan(16);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });
});
