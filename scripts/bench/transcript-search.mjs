// Benchmark search transcript (M8 B1) — chọn chiến lược lọc quyền (plan M8 Q1) bằng SỐ ĐO.
//
// Chạy: `pnpm build && pnpm bench:transcript-search` (cần Postgres dev: `docker compose up -d postgres`).
//   --keep    giữ lại database tạm để tự EXPLAIN thêm
//   --plans   in kế hoạch thực thi (text) của từng ca
// BENCH_ADMIN_URL: kết nối có quyền CREATE DATABASE (mặc định Postgres của compose).
//
// So hai hình dạng cho CÙNG kết quả (đã đối chiếu bằng test oracle):
//   A "đoạn trước": GIN lấy mọi đoạn khớp của org → gom theo meeting → nối meetings + điều kiện xem.
//   B "meeting trước": đi meeting mới → cũ, giữ meeting xem được CÓ đoạn khớp (EXISTS), dừng ở LIMIT.
// Tham số: từ khoá phổ biến / vừa / hiếm × người xem thấy nhiều / ít / rất ít meeting.
//
// File .mjs chạy trên `dist/` (code đã build), không qua typecheck: công cụ dev, không vào CI.
import 'reflect-metadata';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createPgPool } from '../../dist/infra/database/database.module.js';
import { runMigrations } from '../../dist/infra/database/migrate.js';
import * as schema from '../../dist/infra/database/schema/index.js';
import { meetingVisibleTo } from '../../dist/modules/meetings/meeting-visibility.js';
import { TranscriptsRepository } from '../../dist/modules/transcripts/transcripts.repository.js';

const ADMIN_URL =
  process.env.BENCH_ADMIN_URL ?? 'postgres://meetnote:meetnote@localhost:5432/postgres';
const KEEP = process.argv.includes('--keep');
const PLANS = process.argv.includes('--plans');
const MEETINGS = 10_000;
const SEGMENTS = 60;
const RUNS = 5;

const dbName = `meetnote_bench_${Date.now()}`;
const dbUrl = Object.assign(new URL(ADMIN_URL), { pathname: `/${dbName}` }).toString();

/**
 * 10k meeting × 60 đoạn = 600k đoạn. Từ khoá: "hop" ở ~40% đoạn (phổ biến), "ngan sach" ~2% (vừa),
 * "blockchain" ~0,02% (hiếm: ~120 đoạn, rải ~100 meeting). Mọi đoạn có "ke hoach" (rất phổ biến).
 */
const SEED_SQL = `
select setseed(0.42);
insert into users (email, display_name, password_hash)
select 'u' || g || '@bench.test', 'U' || g, 'x' from generate_series(1, 20) g;
create temp table u as select id, substring(email from 2 for position('@' in email) - 2)::int as n from users;
insert into organizations (name, created_by) select 'Bench', id from u where n = 1;
create temp table o as select id from organizations;
insert into organization_members (org_id, user_id, role)
select o.id, u.id, case u.n when 1 then 'owner' when 5 then 'admin' else 'member' end from o, u;

-- 200 kênh RIÊNG TƯ. u2 "dày" ở 150 kênh, u3 "thưa" ở 7 kênh, u4 "rỗng", u5 admin.
insert into channels (org_id, name, visibility, created_by)
select o.id, 'kenh-' || g, 'private', (select id from u where n = 1) from o, generate_series(1, 200) g;
create temp table c as select id, substring(name from 6)::int as n from channels;
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 1), 'owner' from c, o;
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 2), 'member' from c, o where c.n <= 150;
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 3), 'member' from c, o where c.n > 193;

insert into meetings (org_id, owner_id, title, recorded_at, status, source_object_key)
select o.id,
       case when g % 50 = 0 then null
            when g % 2000 = 1 then (select id from u where n = 3)
            else (select id from u where n = ((g * 7919) % 14) + 6) end,
       'Họp ' || g, now() - random() * interval '730 days', 'completed', 'bench/' || g
from o, generate_series(1, ${MEETINGS}) g;
create temp table m as
select id, recorded_at, (floor(random() * 200) + 1)::int as c1 from meetings;
insert into meeting_shares (meeting_id, channel_id, org_id, shared_by, shared_at, recorded_at)
select m.id, c.id, o.id, (select id from u where n = 1), m.recorded_at, m.recorded_at
from m, o, c where c.n = m.c1;

insert into transcript_segments (meeting_id, org_id, seq, start_ms, end_ms, text)
select m.id, o.id, s - 1, (s - 1) * 1000, (s - 1) * 1000 + 900,
       'Kế hoạch ' ||
       case when random() < 0.4 then 'họp ' else '' end ||
       case when random() < 0.02 then 'ngân sách ' else '' end ||
       case when random() < 0.0002 then 'blockchain ' else '' end ||
       'đoạn ' || s
from m, o, generate_series(1, ${SEGMENTS}) s;
`;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  console.log(`DB tạm: ${dbName}`);
  const pool = createPgPool({
    connectionString: dbUrl,
    max: 2,
    applicationName: 'bench',
    lockTimeoutMs: 3_000,
    statementTimeoutMs: 900_000, // seed + vacuum chạy lâu
    idleInTransactionTimeoutMs: 30_000,
  });
  try {
    await runMigrations(dbUrl);
    const started = Date.now();
    await pool.query(SEED_SQL);
    await pool.query('vacuum analyze');
    const counts = (
      await pool.query(
        `select (select count(*) from meetings) as meetings, (select count(*) from transcript_segments) as segments,
                pg_size_pretty(pg_relation_size('transcript_segments_search_idx')) as gin`,
      )
    ).rows[0];
    console.log(`Sinh dữ liệu ${((Date.now() - started) / 1000).toFixed(1)} s:`, counts);

    let captured = [];
    const db = drizzle({
      client: pool,
      schema,
      casing: 'snake_case',
      logger: { logQuery: (query, params) => captured.push({ query, params }) },
    });
    const repo = new TranscriptsRepository(db);
    const orgId = (await pool.query('select id from organizations')).rows[0].id;
    const userOf = async (n) =>
      (await pool.query(`select id from users where email = $1`, [`u${n}@bench.test`])).rows[0].id;
    const viewers = [
      { name: 'dày (150/200 kênh)', viewer: { userId: await userOf(2), orgRole: 'member' } },
      { name: 'thưa (7 kênh)', viewer: { userId: await userOf(3), orgRole: 'member' } },
      { name: 'rỗng (không kênh)', viewer: { userId: await userOf(4), orgRole: 'member' } },
    ];
    const terms = [
      ['rất phổ biến (100%)', 'ke hoach'],
      ['phổ biến (40%)', 'hop'],
      ['vừa (2%)', 'ngan sach'],
      ['hiếm (0,02%)', 'blockchain'],
    ];

    /** B: meeting mới → cũ, giữ meeting xem được có đoạn khớp. Cùng kết quả với A. */
    const searchB = (p) => {
      const tsquery = sql`websearch_to_tsquery('meetnote_vi'::regconfig, ${p.query})`;
      return db
        .select({ id: schema.meetings.id })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.orgId, p.orgId),
            meetingVisibleTo(p.viewer),
            sql`exists (select 1 from ${schema.transcriptSegments} where ${schema.transcriptSegments.meetingId} = ${schema.meetings.id} and ${schema.transcriptSegments.search} @@ ${tsquery})`,
          ),
        )
        .orderBy(desc(schema.meetings.recordedAt), desc(schema.meetings.id))
        .limit(p.limit + 1);
    };

    const results = [];
    const time = async (label, run) => {
      captured = [];
      const rows = await run(); // warm-up + bắt SQL
      const queries = captured;
      const times = [];
      for (let i = 0; i < RUNS; i++) {
        let total = 0;
        for (const { query, params } of queries) {
          const [plan] = (await pool.query(`explain (analyze, format json) ${query}`, params))
            .rows[0]['QUERY PLAN'];
          total += plan['Execution Time'];
        }
        times.push(total);
      }
      if (PLANS) {
        for (const { query, params } of queries) {
          const text = (await pool.query(`explain (analyze, buffers) ${query}`, params)).rows
            .map((r) => r['QUERY PLAN'])
            .join('\n');
          console.log(`\n### ${label}\n${text}`);
        }
      }
      return { ms: median(times), rows: rows.length };
    };

    for (const v of viewers) {
      for (const [termName, query] of terms) {
        const p = { orgId, viewer: v.viewer, query, limit: 20 };
        const a = await time(`A ${v.name} ${termName}`, () => repo.searchMeetings(p));
        const b = await time(`B ${v.name} ${termName}`, () => searchB(p));
        results.push({ viewer: v.name, term: termName, a, b });
      }
    }

    console.log(
      `\n| Người xem | Từ khoá | A: đoạn trước (ms) | B: meeting trước (ms) | Dòng trả A / B |`,
    );
    console.log('| --- | --- | ---: | ---: | ---: |');
    for (const r of results) {
      console.log(
        `| ${r.viewer} | ${r.term} | ${r.a.ms.toFixed(1)} | ${r.b.ms.toFixed(1)} | ${r.a.rows} / ${r.b.rows} |`,
      );
    }
  } finally {
    await pool.end();
    if (KEEP) {
      console.log(`\nGiữ DB: ${dbUrl}`);
    } else {
      await admin.query(`drop database ${dbName} with (force)`);
    }
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
