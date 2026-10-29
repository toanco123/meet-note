import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicSummarizer } from '../../../../src/infra/llm/anthropic.summarizer.js';
import { LlmPermanentError, LlmTransientError } from '../../../../src/infra/llm/llm.errors.js';
import type { AnthropicSummarizerOptions } from '../../../../src/infra/llm/llm.types.js';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT } from '../../../../src/infra/llm/summary-format.js';

interface StubReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

const SUMMARY = {
  overview: 'Họp về kế hoạch quý ba.',
  keyPoints: ['Ngân sách marketing'],
  decisions: ['Chốt kế hoạch quý ba'],
  actionItems: [{ owner: 'Bình', task: 'Chuẩn bị ngân sách', due: 'thứ sáu', dueDate: null }],
};
const message = (over: Record<string, unknown> = {}, content: unknown = SUMMARY) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  },
  ...over,
});
const apiError = (status: number, type: string) => ({
  status,
  body: { type: 'error', error: { type, message: `lỗi giả ${status}` } },
});

/**
 * Adapter Claude với HTTP STUB (M6 Q2 / B3): SDK thật, `baseURL` trỏ vào server cục bộ ghi lại
 * request và trả response theo kịch bản. Không gọi API thật trên CI.
 */
describe('AnthropicSummarizer (HTTP stub)', () => {
  let server: Server;
  let baseURL: string;
  const replies: StubReply[] = [];
  const requests: Array<{
    url: string;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) });
        const reply = replies.shift() ?? { body: message() };
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(reply.status ?? 200, {
            'content-type': 'application/json',
            ...reply.headers,
          });
          res.end(JSON.stringify(reply.body));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    replies.length = 0;
    requests.length = 0;
  });

  const summarizer = (over: Partial<AnthropicSummarizerOptions> = {}) =>
    new AnthropicSummarizer({
      model: 'claude-opus-5-5',
      effort: 'medium',
      apiKey: 'sk-test',
      baseURL,
      maxRetries: 0,
      timeoutMs: 5_000,
      chunkChars: 300_000,
      ...over,
    });
  const input = {
    meetingTitle: 'Giao ban',
    meetingDate: '2026-10-27',
    segments: [
      { startMs: 2_000, text: 'Chào mọi người.' },
      { startMs: 3_725_000, text: 'Anh Bình chuẩn bị ngân sách trước thứ sáu.' },
    ],
  };

  it('prompt mang NGÀY HỌP kèm thứ; hạn model quy đúng thì giữ, sai (năm cũ / rác) thì null mà tóm tắt vẫn hợp lệ', async () => {
    const item = (task: string, dueDate: unknown) => ({ owner: 'An', task, due: 'x', dueDate });
    replies.push({
      body: message(
        {},
        {
          ...SUMMARY,
          actionItems: [
            item('đúng', '2026-10-30'),
            item('năm sai', '2024-10-30'),
            item('rác', 'sớm'),
          ],
        },
      ),
    });
    const result = await summarizer().summarize(input);
    expect(JSON.stringify(requests[0]?.body.messages)).toContain(
      'Ngày họp: Thứ ba, 2026-10-27 (giờ Việt Nam).',
    );
    expect(result.content.actionItems.map((i) => [i.task, i.dueDate])).toEqual([
      ['đúng', '2026-10-30'],
      ['năm sai', null],
      ['rác', null],
    ]);
  });

  // Đột biến: bỏ truyền ngày họp vào lượt MAP / REDUCE → chỉ lượt đơn có ngày, hạn quy sai khi dài.
  it('transcript dài (map-reduce): MỌI lượt gọi đều mang ngày họp, và hạn được kiểm theo cùng ngày', async () => {
    replies.push(
      { body: message({}, SUMMARY) },
      { body: message({}, SUMMARY) },
      {
        body: message(
          {},
          { ...SUMMARY, actionItems: [{ ...SUMMARY.actionItems[0], dueDate: '2024-01-01' }] },
        ),
      },
    );
    const long = {
      meetingTitle: 'Dài',
      meetingDate: '2026-10-27',
      segments: [
        { startMs: 0, text: 'a'.repeat(40) },
        { startMs: 1_000, text: 'b'.repeat(40) },
      ],
    };
    const result = await summarizer({ chunkChars: 50 }).summarize(long);
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      expect(JSON.stringify(r.body.messages)).toContain('Ngày họp: Thứ ba, 2026-10-27');
    }
    expect(result.content.actionItems[0]?.dueDate).toBeNull(); // 2024 ngoài khoảng quanh 2026-10-27
  });

  it('một lượt: structured output + fallbacks "default" + effort; trả nội dung, model THẬT phục vụ, token cộng dồn', async () => {
    replies.push({ body: message({ model: 'claude-opus-4-8' }) }); // model dự phòng đã trả lời
    const result = await summarizer().summarize(input);
    const [req] = requests;

    expect(result).toEqual({
      content: SUMMARY,
      model: 'claude-opus-4-8',
      promptVersion: 'v2',
      inputTokens: 105,
      outputTokens: 20,
    });
    expect(req?.url).toContain('/v1/messages');
    expect(req?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req?.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    });
    expect(req?.body.tool_choice).toBeUndefined(); // ép gọi tool → 400 trên Claude Opus 5.5
    const prompt = JSON.stringify(req?.body.messages);
    expect([
      prompt.includes('[00:02] Chào mọi người.'),
      prompt.includes('[1:02:05] Anh Bình'),
    ]).toEqual([true, true]);
  });

  it.each([
    ['không phải JSON', 'xin chào'],
    ['thiếu trường', { overview: 'x', keyPoints: [] }],
    ['owner sai kiểu', { ...SUMMARY, actionItems: [{ owner: 5, task: 'x', due: null }] }],
  ])(
    'kết quả sai schema (%s) → LlmTransientError (chạy lại có thể được)',
    async (_label, content) => {
      replies.push({ body: message({}, content) });
      await expect(summarizer().summarize(input)).rejects.toBeInstanceOf(LlmTransientError);
    },
  );

  it.each([
    [400, 'invalid_request_error', LlmPermanentError],
    [401, 'authentication_error', LlmPermanentError],
    [403, 'permission_error', LlmPermanentError],
    [404, 'not_found_error', LlmPermanentError],
    [429, 'rate_limit_error', LlmTransientError],
    [500, 'api_error', LlmTransientError],
    [529, 'overloaded_error', LlmTransientError],
  ])('HTTP %i (%s) → %o', async (status, type, expected) => {
    replies.push(apiError(status, type));
    await expect(summarizer().summarize(input)).rejects.toBeInstanceOf(expected);
  });

  it.each([['refusal'], ['max_tokens']])(
    'stop_reason %s → LlmPermanentError (không đọc content)',
    async (stopReason) => {
      replies.push({ body: message({ stop_reason: stopReason }) });
      await expect(summarizer().summarize(input)).rejects.toBeInstanceOf(LlmPermanentError);
    },
  );

  it('SDK tự retry 429 (tôn trọng `retry-after`) trước khi tới BullMQ', async () => {
    replies.push(
      { ...apiError(429, 'rate_limit_error'), headers: { 'retry-after': '0' } },
      { body: message() },
    );
    const result = await summarizer({ maxRetries: 1 }).summarize(input);
    expect([requests.length, result.content]).toEqual([2, SUMMARY]);
  });

  it('quá timeout → LlmTransientError', async () => {
    replies.push({ body: message(), delayMs: 1_000 });
    await expect(summarizer({ timeoutMs: 200 }).summarize(input)).rejects.toBeInstanceOf(
      LlmTransientError,
    );
  });

  it('huỷ (worker tắt) → ném nguyên APIUserAbortError, không đổi thành lỗi LLM', async () => {
    replies.push({ body: message(), delayMs: 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      summarizer().summarize(input, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
  });

  // Đột biến: bỏ bước reduce (trả bản tóm tắt phần cuối) → thiếu 1 request, nội dung sai.
  it('transcript vượt chunkChars → MAP từng phần rồi một lượt REDUCE nhận các bản tóm tắt phần', async () => {
    const segments = Array.from({ length: 6 }, (_, i) => ({
      startMs: i * 1_000,
      text: `Câu số ${i}.`,
    }));
    const partial = (i: number) => ({ ...SUMMARY, overview: `Phần ${i}` });
    replies.push(
      { body: message({}, partial(1)) },
      { body: message({}, partial(2)) },
      { body: message({}, partial(3)) },
      { body: message({}, { ...SUMMARY, overview: 'Đã gộp' }) },
    );
    const result = await summarizer({ chunkChars: 40 }).summarize({
      meetingTitle: 'Dài',
      meetingDate: '2026-10-27',
      segments,
    });
    const reducePrompt = JSON.stringify(requests.at(-1)?.body.messages);

    expect([requests.length, result.content.overview, result.inputTokens]).toEqual([
      4,
      'Đã gộp',
      420,
    ]);
    expect(['Phần 1', 'Phần 2', 'Phần 3'].every((p) => reducePrompt.includes(p))).toBe(true);
    expect(JSON.stringify(requests[0]?.body.messages)).toContain('PHẦN 1/3');
  });
});
