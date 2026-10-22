import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { runProcess } from '../../src/infra/process/run-process.js';
import { bearer, type TestUser } from './factories.js';

/** 3 giây tiếng bíp AAC sinh bằng ffmpeg `lavfi` — file ghi âm thật cho pipeline (M6). */
export async function generateAudio(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'meetnote-audio-'));
  try {
    const file = join(dir, 'hop.m4a');
    await runProcess('ffmpeg', {
      args: [
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-c:a',
        'aac',
        file,
      ],
      timeoutMs: 30_000,
    });
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Upload THẬT qua HTTP (init → 1 phần → complete, sha256 đúng) → id meeting `queued`. */
export async function uploadAudioMeeting(
  app: INestApplication<App>,
  owner: TestUser,
  orgId: string,
  audio: Buffer,
  title = 'Họp pipeline',
): Promise<string> {
  const http = () => request(app.getHttpServer());
  const as = bearer(owner.tokens.accessToken);
  const uploadId = (
    await http()
      .post(`/v1/orgs/${orgId}/uploads`)
      .set(as)
      .send({
        filename: 'hop.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: audio.length,
        sha256: createHash('sha256').update(audio).digest('hex'),
        title,
        recordedAt: '2026-10-22T02:00:00.000Z',
      })
      .expect(201)
  ).body.data.id as string;
  await http()
    .put(`/v1/orgs/${orgId}/uploads/${uploadId}/parts/1`)
    .set(as)
    .set('Content-Type', 'application/octet-stream')
    .send(audio)
    .expect(200);
  return (await http().post(`/v1/orgs/${orgId}/uploads/${uploadId}/complete`).set(as).expect(201))
    .body.data.id as string;
}
