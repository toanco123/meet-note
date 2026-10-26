import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels, transcriptSegments } from '../../../../src/infra/database/schema/index.js';
import type { MeetingViewer } from '../../../../src/modules/meetings/meetings.types.js';
import { TranscriptsRepository } from '../../../../src/modules/transcripts/transcripts.repository.js';
import type { SearchMeetingsParams } from '../../../../src/modules/transcripts/transcripts.types.js';
import { eq, sql } from 'drizzle-orm';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const VOCAB = [
  'Kế hoạch quý ba',
  'Ngân sách marketing',
  'Tuyển dụng hai kỹ sư',
  'Chốt kế hoạch ra mắt sản phẩm',
  'Chúng ta họp tiếp tuần sau',
  'Đà Nẵng và Hà Nội',
];

/** Bỏ dấu + chữ thường + tách từ — độc lập với Postgres, dùng làm "sự thật" cho từ khoá. */
const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const matches = (text: string, query: string) => {
  const have = new Set(words(text));
  return words(query).every((w) => have.has(w));
};

/**
 * TEST ĐỐI CHIẾU cho search transcript (M8 B1): với mọi người xem × từ khoá, duyệt HẾT các trang
 * (limit nhỏ) và so với "sự thật" tính bằng JS — meeting xem được (đúng 04 §3, dựng tay từng điều) có
 * ít nhất một đoạn khớp theo kiểu "bỏ dấu, đủ mọi từ".
 */
describe('Search transcript = đoạn khớp ∩ meeting xem được (Postgres thật)', () => {
  let t: TestDb;
  let repo: TranscriptsRepository;
  let orgId: string;
  let otherOrgId: string;
  let publicChannelId: string;
  let privateChannelId: string;
  /** Truth: meetingId → các đoạn text, và tập meeting mỗi người xem được (dựng tay theo 04 §3). */
  const texts = new Map<string, string[]>();
  const recorded = new Map<string, number>();
  const viewers: Array<{ name: string; viewer: MeetingViewer; visible: Set<string> }> = [];

  let seed = 11;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % n;
  };

  beforeAll(async () => {
    t = createTestDb();
    repo = new TranscriptsRepository(t.db);
    const owner = await insertUser(t.db);
    orgId = (await insertOrg(t.db, owner.id)).id;
    otherOrgId = (await insertOrg(t.db, owner.id)).id;
    const [admin, author, member, guest, newbie] = await Promise.all(
      Array.from({ length: 5 }, () => insertUser(t.db)),
    );
    await addMember(t.db, orgId, admin!.id, 'admin');
    for (const u of [author, member, guest, newbie]) await addMember(t.db, orgId, u!.id);

    const pub = await insertChannel(t.db, orgId, owner.id, { visibility: 'public' });
    const priv = await insertChannel(t.db, orgId, owner.id, { visibility: 'private' });
    const privDeleted = await insertChannel(t.db, orgId, owner.id, { visibility: 'private' });
    const pubDeleted = await insertChannel(t.db, orgId, owner.id, { visibility: 'public' });
    publicChannelId = pub.id;
    privateChannelId = priv.id;
    await t.db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(sql`${channels.id} in (${privDeleted.id}, ${pubDeleted.id})`);
    await addChannelMember(t.db, priv, orgId, member!.id, 'member');
    await addChannelMember(t.db, priv, orgId, guest!.id, 'guest');
    await addChannelMember(t.db, privDeleted, orgId, newbie!.id, 'member');

    // 40 meeting: chủ author / KHÔNG CHỦ; share vào các kênh (kể cả đã xoá); ~1/6 đã xoá; mỗi meeting
    // 1–4 đoạn lấy từ VOCAB. Meeting của org KHÁC cũng chứa đúng các từ đó (không bao giờ được lọt).
    const meetingsInfo: Array<{
      id: string;
      owner: string | null;
      shares: string[];
      dead: boolean;
    }> = [];
    for (let i = 0; i < 40; i++) {
      const ownerId = rand(3) === 0 ? null : author!.id;
      const dead = rand(6) === 0;
      const at = new Date(Date.UTC(2026, 0, 1 + rand(5)));
      const m = await insertMeeting(t.db, orgId, ownerId, {
        recordedAt: at,
        ...(dead && { deletedAt: new Date() }),
      });
      const shares = [pub, priv, privDeleted, pubDeleted]
        .filter(() => rand(4) === 0)
        .map((c) => c.id);
      for (const channelId of shares) await shareMeeting(t.db, orgId, m.id, channelId);
      const lines = Array.from({ length: 1 + rand(4) }, () => VOCAB[rand(VOCAB.length)]!);
      await t.db.insert(transcriptSegments).values(
        lines.map((text, seq) => ({
          meetingId: m.id,
          orgId,
          seq,
          startMs: seq * 1000,
          endMs: seq * 1000 + 900,
          text,
        })),
      );
      texts.set(m.id, lines);
      recorded.set(m.id, at.getTime());
      meetingsInfo.push({ id: m.id, owner: ownerId, shares, dead });
    }
    const foreign = await insertMeeting(t.db, otherOrgId, owner.id);
    await t.db.insert(transcriptSegments).values(
      VOCAB.map((text, seq) => ({
        meetingId: foreign.id,
        orgId: otherOrgId,
        seq,
        startMs: 0,
        endMs: 1,
        text,
      })),
    );

    // Điều kiện xem dựng TAY (04 §3), độc lập với `meetingVisibleTo`.
    // Lưu ý: `insertChannel` thêm người tạo (owner org) làm thành viên của MỌI kênh nó tạo.
    const liveChannel = new Set([pub.id, priv.id]);
    const visibleFor = (userId: string, role: 'owner' | 'admin' | 'member', member: string[]) =>
      new Set(
        meetingsInfo
          .filter((m) => !m.dead)
          .filter(
            (m) =>
              m.owner === userId ||
              m.shares.some((c) => liveChannel.has(c) && (c === pub.id || member.includes(c))) ||
              (m.owner === null && role !== 'member'),
          )
          .map((m) => m.id),
      );
    viewers.push(
      {
        name: 'Owner org',
        viewer: { userId: owner.id, orgRole: 'owner' },
        visible: visibleFor(owner.id, 'owner', [priv.id]),
      },
      {
        name: 'Admin org',
        viewer: { userId: admin!.id, orgRole: 'admin' },
        visible: visibleFor(admin!.id, 'admin', []),
      },
      {
        name: 'chủ meeting',
        viewer: { userId: author!.id, orgRole: 'member' },
        visible: visibleFor(author!.id, 'member', []),
      },
      {
        name: 'thành viên kênh riêng',
        viewer: { userId: member!.id, orgRole: 'member' },
        visible: visibleFor(member!.id, 'member', [priv.id]),
      },
      {
        name: 'khách kênh riêng',
        viewer: { userId: guest!.id, orgRole: 'member' },
        visible: visibleFor(guest!.id, 'member', [priv.id]),
      },
      {
        name: 'mới vào (kênh đã xoá)',
        viewer: { userId: newbie!.id, orgRole: 'member' },
        visible: visibleFor(newbie!.id, 'member', []),
      },
    );
  });

  afterAll(async () => {
    await t.close();
  });

  /** Duyệt HẾT các trang như client (limit 3, cursor = dòng cuối) — bắt cả lỗi "dừng sớm". */
  async function allPages(p: Omit<SearchMeetingsParams, 'limit' | 'after'>) {
    const rows: Array<{ id: string; hitCount: number }> = [];
    let after: SearchMeetingsParams['after'];
    for (;;) {
      const page = await repo.searchMeetings({ ...p, limit: 3, after });
      rows.push(...page.slice(0, 3));
      if (page.length <= 3) return rows;
      const last = page[2]!;
      after = { recordedAt: last.recordedAtKey, id: last.id };
    }
  }

  const expectedFor = (visible: Set<string>, query: string) =>
    [...visible]
      .map((id) => ({ id, hits: texts.get(id)!.filter((tx) => matches(tx, query)).length }))
      .filter((m) => m.hits > 0)
      .sort((a, b) => recorded.get(b.id)! - recorded.get(a.id)! || b.id.localeCompare(a.id));

  it('mọi người xem × từ khoá (có / không dấu, nhiều từ, không khớp) × duyệt hết trang → đúng tập, thứ tự, số đoạn', async () => {
    const queries = [
      'ke hoach',
      'kế hoạch',
      'NGAN SACH',
      'ra mat san pham',
      'Đà Nẵng',
      'khong co tu nay',
    ];
    const mismatches: string[] = [];
    let compared = 0;
    for (const { name, viewer, visible } of viewers) {
      for (const query of queries) {
        const expected = expectedFor(visible, query);
        const actual = await allPages({ orgId, viewer, query });
        compared += expected.length;
        const [e, a] = [
          JSON.stringify(expected.map((m) => [m.id, m.hits])),
          JSON.stringify(actual.map((m) => [m.id, m.hitCount])),
        ];
        if (e !== a)
          mismatches.push(`${name} / "${query}": mong ${expected.length}, nhận ${actual.length}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });

  it('lọc theo kênh: chỉ meeting share vào kênh đó (và vẫn là meeting xem được)', async () => {
    const { viewer, visible } = viewers.find((v) => v.name === 'thành viên kênh riêng')!;
    const shared = new Set(
      (
        await t.db.execute<{ meeting_id: string }>(
          sql`select meeting_id from meeting_shares where channel_id = ${privateChannelId}`,
        )
      ).rows.map((r) => r.meeting_id),
    );
    const expected = expectedFor(
      new Set([...visible].filter((id) => shared.has(id))),
      'ke hoach',
    ).map((m) => m.id);
    const actual = (
      await allPages({ orgId, viewer, query: 'ke hoach', channelId: privateChannelId })
    ).map((m) => m.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected);
    expect(publicChannelId).not.toBe(privateChannelId);
  });

  it('org khác không bao giờ lọt: query ở org A không thấy đoạn của org B dù cùng từ khoá', async () => {
    const owner = viewers[0]!.viewer;
    const inOther = await repo.searchMeetings({
      orgId: otherOrgId,
      viewer: owner,
      query: 'ke hoach',
      limit: 50,
    });
    const inMain = await allPages({ orgId, viewer: owner, query: 'ke hoach' });
    expect(inOther).toHaveLength(1); // org B có đúng 1 meeting
    expect(inMain.map((m) => m.id)).not.toContain(inOther[0]!.id);
    expect((await t.db.select().from(channels).where(eq(channels.orgId, otherOrgId))).length).toBe(
      0,
    );
  });

  it('chuỗi lạ không làm câu lỗi cú pháp (websearch_to_tsquery): dấu nháy, toán tử, rỗng', async () => {
    const viewer = viewers[0]!.viewer;
    for (const query of ["'", '"', '& | !', '(((', 'ke -hoach', '"ke hoach"', 'or or or']) {
      await expect(repo.searchMeetings({ orgId, viewer, query, limit: 5 })).resolves.toBeDefined();
    }
  });
});
