import { describe, expect, it } from 'vitest';
import { JobName, statsRollupJobId } from '../../../../src/infra/queue/jobs.js';
import { SCHEDULES } from '../../../../src/worker/worker-schedules.js';

const ORG = '019d0000-0000-7000-8000-000000000001';

describe('statsRollupJobId (M17)', () => {
  it('đúng dạng <tên-job>.<org>.<ngày>.<hậu tố> và KHÔNG có dấu ":" (BullMQ cấm)', () => {
    const id = statsRollupJobId(ORG, '2026-10-05', 'e1730000000000');
    expect(id).toBe(`stats.rollup.${ORG}.2026-10-05.e1730000000000`);
    expect(id).not.toContain(':');
  });

  it('hậu tố khác nhau → jobId khác nhau (yêu cầu mới sau khi job cũ completed không bị nuốt)', () => {
    expect(statsRollupJobId(ORG, '2026-10-05', 'e1')).not.toBe(
      statsRollupJobId(ORG, '2026-10-05', 'e2'),
    );
    expect(statsRollupJobId(ORG, '2026-10-05', 't7')).toBe(
      statsRollupJobId(ORG, '2026-10-05', 't7'),
    );
  });

  it('khác ngày hoặc khác tổ chức → khác jobId', () => {
    expect(statsRollupJobId(ORG, '2026-10-05', 't7')).not.toBe(
      statsRollupJobId(ORG, '2026-10-06', 't7'),
    );
    expect(statsRollupJobId(ORG, '2026-10-05', 't7')).not.toBe(
      statsRollupJobId('019d0000-0000-7000-8000-000000000002', '2026-10-05', 't7'),
    );
  });
});

describe('lịch rollup (M17)', () => {
  const byId = (id: string) => SCHEDULES.find((s) => s.id === id);

  it('tick mỗi 5 phút, job đêm 03:30 (lệch 30 phút với purge kênh 03:00)', () => {
    expect(byId('stats-tick')).toMatchObject({ pattern: '*/5 * * * *', name: JobName.StatsTick });
    expect(byId('stats-reconcile')).toMatchObject({
      pattern: '30 3 * * *',
      name: JobName.StatsReconcile,
    });
  });
});
