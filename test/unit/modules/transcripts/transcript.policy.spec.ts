import { describe, expect, it } from 'vitest';
import { decideTranscriptEdit } from '../../../../src/modules/transcripts/transcript.policy.js';

const OWNER = 'u-owner';
const OTHER = 'u-other';

describe('decideTranscriptEdit (M13 Q1) — quyền trước, trạng thái sau', () => {
  it.each([
    ['chủ meeting, completed', OWNER, 'member', 'completed', 'ok'],
    ['chủ meeting, đang summarizing', OWNER, 'member', 'summarizing', 'not_completed'],
    ['chủ meeting, failed', OWNER, 'member', 'failed', 'not_completed'],
    ['member khác, completed', OTHER, 'member', 'completed', 'forbidden'],
    ['Admin org, meeting CÓ chủ', OTHER, 'admin', 'completed', 'forbidden'],
    ['Owner org, meeting CÓ chủ', OTHER, 'owner', 'completed', 'forbidden'],
    // Không quyền thì KHÔNG được biết meeting đang ở bước nào (403 trước 409).
    ['member khác, meeting đang chạy', OTHER, 'member', 'transcribing', 'forbidden'],
  ] as const)('%s → %s', (_label, userId, orgRole, status, expected) => {
    expect(decideTranscriptEdit({ ownerId: OWNER, status }, { userId, orgRole })).toBe(expected);
  });

  it.each([
    ['Admin org, completed', 'admin', 'completed', 'ok'],
    ['Owner org, completed', 'owner', 'completed', 'ok'],
    ['Admin org, chưa xong', 'admin', 'queued', 'not_completed'],
    ['member, meeting không chủ', 'member', 'completed', 'forbidden'],
  ] as const)('meeting KHÔNG chủ (Q2 M6b): %s → %s', (_label, orgRole, status, expected) => {
    expect(decideTranscriptEdit({ ownerId: null, status }, { userId: OTHER, orgRole })).toBe(
      expected,
    );
  });
});
