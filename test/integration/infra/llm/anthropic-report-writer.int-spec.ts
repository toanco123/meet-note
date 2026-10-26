import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicReportWriter } from '../../../../src/infra/llm/anthropic.report-writer.js';
import { LlmPermanentError, LlmTransientError } from '../../../../src/infra/llm/llm.errors.js';
import type {
  AnthropicReportWriterOptions,
  ReportInput,
} from '../../../../src/infra/llm/llm.types.js';
import { REPORT_SCHEMA, REPORT_SYSTEM_PROMPT } from '../../../../src/infra/llm/report-format.js';

interface StubReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

const REPORT = {
  overview: 'Tuần này chốt kế hoạch quý ba.',
  highlights: ['Ngân sách marketing', 'Tuyển dụng'],
  decisions: ['Chốt kế hoạch quý ba'],
  actionItems: [{ owner: 'Bình', task: 'Chuẩn bị ngân sách', due: 'thứ sáu' }],
};
const message = (over: Record<string, unknown> = {}, content: unknown = REPORT) => ({
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
    input_tokens: 400,
    output_tokens: 120,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 10,
  },
  ...over,
});
const apiError = (status: number, type: string) => ({
  status,
  body: { type: 'error', error: { type, message: `lỗi giả ${status}` } },
});

const input: ReportInput = {
  channelName: 'Kinh doanh',
  weekStart: '2026-10-05',
  weekEnd: '2026-10-11',
  meetings: [
    {
      id: 'm1',
      title: 'Họp ngân sách',
      recordedAt: '2026-10-06T02:00:00.000Z',
      summary: {
        overview: 'Bàn ngân sách.',
        keyPoints: ['Marketing'],
        decisions: ['Chốt ngân sách'],
        actionItems: [{ owner: 'Bình', task: 'Chuẩn bị ngân sách', due: 'thứ sáu' }],
      },
    },
  ],
};

/** Adapter báo cáo tuần với HTTP STUB (M9 B3): SDK thật, `baseURL` trỏ vào server cục bộ. */
describe('AnthropicReportWriter (HTTP stub)', () => {
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

  const writer = (over: Partial<AnthropicReportWriterOptions> = {}) =>
    new AnthropicReportWriter({
      model: 'claude-opus-5-5',
      effort: 'medium',
      apiKey: 'sk-test',
      baseURL,
      maxRetries: 0,
      timeoutMs: 5_000,
      ...over,
    });

  it('một lượt: structured output + fallbacks + effort; trả nội dung, model THẬT phục vụ, token tính cả cache', async () => {
    replies.push({ body: message({ model: 'claude-opus-4-8' }) });
    const result = await writer().write(input);
    const [req] = requests;

    expect(result).toEqual({
      content: REPORT,
      model: 'claude-opus-4-8',
      promptVersion: 'v1',
      inputTokens: 410,
      outputTokens: 120,
    });
    expect(requests).toHaveLength(1);
    expect(req?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req?.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      system: REPORT_SYSTEM_PROMPT,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: REPORT_SCHEMA } },
    });
    expect(req?.body.tool_choice).toBeUndefined();
    const prompt = JSON.stringify(req?.body.messages);
    expect([prompt.includes('Họp ngân sách'), prompt.includes('2026-10-11')]).toEqual([true, true]);
  });

  it.each([
    ['không phải JSON', 'xin chào'],
    ['thiếu trường', { overview: 'x', highlights: [] }],
    ['overview rỗng', { ...REPORT, overview: ' ' }],
    ['owner sai kiểu', { ...REPORT, actionItems: [{ owner: 5, task: 'x', due: null }] }],
  ])('kết quả sai schema (%s) → LlmTransientError (chạy lại có thể được)', async (_l, content) => {
    replies.push({ body: message({}, content) });
    await expect(writer().write(input)).rejects.toBeInstanceOf(LlmTransientError);
  });

  it.each([
    [400, 'invalid_request_error', LlmPermanentError],
    [401, 'authentication_error', LlmPermanentError],
    [429, 'rate_limit_error', LlmTransientError],
    [500, 'api_error', LlmTransientError],
    [529, 'overloaded_error', LlmTransientError],
  ])('HTTP %i (%s) → %o', async (status, type, expected) => {
    replies.push(apiError(status, type));
    await expect(writer().write(input)).rejects.toBeInstanceOf(expected);
  });

  it.each([['refusal'], ['max_tokens']])(
    'stop_reason %s → LlmPermanentError (không đọc content)',
    async (stopReason) => {
      replies.push({ body: message({ stop_reason: stopReason }) });
      await expect(writer().write(input)).rejects.toBeInstanceOf(LlmPermanentError);
    },
  );

  it('SDK tự retry 429 trước khi tới BullMQ; quá timeout → tạm; huỷ → APIUserAbortError nguyên', async () => {
    replies.push(
      { ...apiError(429, 'rate_limit_error'), headers: { 'retry-after': '0' } },
      { body: message() },
    );
    const retried = await writer({ maxRetries: 1 }).write(input);
    const requestsForRetry = requests.length; // 429 rồi 200 = 2 request (chụp trước các lời gọi sau)

    replies.push({ body: message(), delayMs: 1_000 });
    const timeout = writer({ timeoutMs: 200 }).write(input);

    replies.push({ body: message(), delayMs: 1_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = writer().write(input, { signal: controller.signal });

    // Gom bằng allSettled: không để promise bị từ chối sớm (huỷ lúc 50 ms) chờ ai đó gắn handler.
    const [timeoutResult, abortResult] = await Promise.allSettled([timeout, aborted]);
    expect(requestsForRetry).toBe(2);
    expect(retried.content).toEqual(REPORT);
    expect(timeoutResult.status === 'rejected' && timeoutResult.reason).toBeInstanceOf(
      LlmTransientError,
    );
    expect(abortResult.status === 'rejected' && abortResult.reason).toBeInstanceOf(
      Anthropic.APIUserAbortError,
    );
  });
});
