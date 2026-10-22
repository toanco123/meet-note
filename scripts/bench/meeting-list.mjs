// Benchmark danh sách meeting theo tổ chức (M11 B4) — đo ĐÚNG câu SQL mà code đang chạy.
//
// Chạy: `pnpm build && pnpm bench:meeting-list` (cần Postgres dev: `docker compose up -d postgres`).
//   --keep    giữ lại database tạm để tự EXPLAIN thêm
//   --plans   in kế hoạch thực thi (text) của từng ca
// BENCH_ADMIN_URL: kết nối có quyền CREATE DATABASE (mặc định Postgres của compose).
//
// File .mjs chạy trên `dist/` (code đã build), không qua typecheck: công cụ dev, không vào CI.
import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../../dist/infra/database/migrate.js';
import * as schema from '../../dist/infra/database/schema/index.js';
import { MeetingsRepository } from '../../dist/modules/meetings/repositories/meetings.repository.js';

const ADMIN_URL =
  process.env.BENCH_ADMIN_URL ?? 'postgres://meetnote:meetnote@localhost:5432/postgres';
const KEEP = process.argv.includes('--keep');
const PLANS = process.argv.includes('--plans');
const RUNS = 7;

const dbName = `meetnote_bench_${Date.now()}`;
const dbUrl = Object.assign(new URL(ADMIN_URL), { pathname: `/${dbName}` }).toString();

/** Sinh dữ liệu trong Postgres (nhanh hơn insert từ JS cả trăm lần); `setseed` → lần nào cũng như nhau. */
const SEED_SQL = `
select setseed(0.42);

insert into users (email, display_name, password_hash)
select 'u' || g || '@bench.test', 'U' || g, 'x' from generate_series(1, 2004) g;
create temp table u as select id, substring(email from 2 for position('@' in email) - 2)::int as n from users;

insert into organizations (name, created_by) select 'Bench', id from u where n = 1;
create temp table o as select id from organizations;
insert into organization_members (org_id, user_id, role)
select o.id, u.id, case u.n when 1 then 'owner' when 5 then 'admin' else 'member' end from o, u;

-- 200 kênh RIÊNG TƯ, chủ là u1.
insert into channels (org_id, name, visibility, created_by)
select o.id, 'kenh-' || g, 'private', (select id from u where n = 1) from o, generate_series(1, 200) g;
create temp table c as select id, substring(name from 6)::int as n from channels;
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 1), 'owner' from c, o;
-- ~49 thành viên mỗi kênh, lấy từ u6..u2004 (u2..u5 là người xem của benchmark).
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, u.id, 'member'
from c, o, generate_series(1, 49) k, u
where u.n = ((c.n * 37 + k * 53) % 1999) + 6
on conflict do nothing;
-- Người xem: u2 "dày" ở 150 kênh, u3 "thưa" ở 7 kênh; u4 "rỗng", u5 admin: không ở kênh nào.
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 2), 'member' from c, o where c.n <= 150;
insert into channel_members (channel_id, org_id, user_id, role)
select c.id, o.id, (select id from u where n = 3), 'member' from c, o where c.n > 193;

-- 100k meeting trong 2 năm; 2% không chủ; u3 sở hữu 50; 10% chưa xử lý xong (lọc status).
insert into meetings (org_id, owner_id, title, recorded_at, status, source_object_key)
select o.id,
       case when g % 50 = 0 then null
            when g % 2000 = 1 then (select id from u where n = 3)
            else (select id from u where n = ((g * 7919) % 1999) + 6) end,
       'Họp ' || g,
       now() - random() * interval '730 days',
       case when random() < 0.1 then 'failed' else 'completed' end,
       'bench/' || g
from o, generate_series(1, 100000) g;
-- Kênh chọn bằng random() (cố định nhờ setseed): công thức số học như 'g * 31 % 200' tương quan với
-- 'g % 10' (status) → có người xem không bao giờ thấy meeting 'failed' (lần chạy đầu gặp).
create temp table m as
select id, owner_id, recorded_at,
       (floor(random() * 200) + 1)::int as c1,
       case when random() < 0.2 then (floor(random() * 200) + 1)::int end as c2
from meetings;

-- Mỗi meeting share vào 1 kênh, ~20% thêm kênh thứ hai → ~120k share.
insert into meeting_shares (meeting_id, channel_id, org_id, shared_by, shared_at)
select m.id, c.id, o.id, m.owner_id, m.recorded_at + interval '1 hour'
from m, o, c where c.n = m.c1
union all
select m.id, c.id, o.id, m.owner_id, m.recorded_at + interval '2 hours'
from m, o, c where c.n = m.c2 and m.c2 <> m.c1
on conflict do nothing;
`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  console.log(`DB tạm: ${dbName}`);
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  try {
    await runMigrations(dbUrl);
    const started = Date.now();
    await pool.query(SEED_SQL);
    await pool.query('vacuum analyze');
    const counts = (
      await pool.query(
        `select (select count(*) from meetings) as meetings, (select count(*) from meeting_shares) as shares,
                (select count(*) from channel_members) as channel_members`,
      )
    ).rows[0];
    console.log(`Sinh dữ liệu ${((Date.now() - started) / 1000).toFixed(1)} s:`, counts);

    let captured;
    const db = drizzle({
      client: pool,
      schema,
      casing: 'snake_case',
      logger: { logQuery: (query, params) => (captured = { query, params }) },
    });
    const repo = new MeetingsRepository(db);
    const orgId = (await pool.query('select id from organizations')).rows[0].id;
    const userOf = async (n) =>
      (await pool.query(`select id from users where email = $1`, [`u${n}@bench.test`])).rows[0].id;
    const profiles = [
      { name: 'dày (150/200 kênh)', viewer: { userId: await userOf(2), orgRole: 'member' } },
      {
        name: 'thưa (7 kênh + 50 của mình)',
        viewer: { userId: await userOf(3), orgRole: 'member' },
      },
      { name: 'rỗng (thành viên mới)', viewer: { userId: await userOf(4), orgRole: 'member' } },
      {
        name: 'admin (0 kênh, thấy meeting không chủ)',
        viewer: { userId: await userOf(5), orgRole: 'admin' },
      },
    ];

    const results = [];
    const measure = async (profile, page, params) => {
      await repo.listVisible(params); // warm-up + bắt câu SQL
      const { query, params: binds } = captured;
      const times = [];
      let buffers = 0;
      let rows = 0;
      let planText = '';
      for (let i = 0; i < RUNS; i++) {
        const [explained] = (
          await pool.query(`explain (analyze, buffers, format json) ${query}`, binds)
        ).rows[0]['QUERY PLAN'];
        times.push(explained['Execution Time']);
        buffers = explained.Plan['Shared Hit Blocks'] + explained.Plan['Shared Read Blocks'];
        rows = explained.Plan['Actual Rows'];
      }
      if (PLANS) {
        planText = (await pool.query(`explain (analyze, buffers) ${query}`, binds)).rows
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        console.log(`\n### ${profile.name} — ${page}\n${planText}`);
      }
      results.push({ profile: profile.name, page, ms: median(times), buffers, rows });
    };

    for (const profile of profiles) {
      const base = { orgId, viewer: profile.viewer, limit: 20 };
      await measure(profile, 'trang 1', base);
      const deep = await repo.listVisible({ ...base, limit: 1000 });
      const last = deep.at(-2); // limit + 1 dòng: dòng cuối là dòng "còn trang sau"
      if (last) {
        await measure(profile, 'sau 1000 dòng', {
          ...base,
          after: { recordedAt: last.recordedAtKey, id: last.id },
        });
      }
      await measure(profile, 'lọc status=failed', { ...base, status: 'failed' });
    }

    console.log('\n| Người xem | Trang | Trung vị (ms) | Buffers | Dòng trả |');
    console.log('| --- | --- | ---: | ---: | ---: |');
    for (const r of results) {
      console.log(`| ${r.profile} | ${r.page} | ${r.ms.toFixed(2)} | ${r.buffers} | ${r.rows} |`);
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

await main();
