import { describe, expect, it } from 'vitest';
import { transcodeJobSchema, transcodeResultSchema } from './jobs.ts';

const videoId = '0123456789abcdef01234567';
const prefix = `videos/${videoId}/hls/0b5f6c2e-8a5d-4c3e-9f1a-2b3c4d5e6f70`;

describe('transcodeJobSchema', () => {
  it('accepts API-generated source keys only', () => {
    const job = {
      videoId,
      sourceKey: `videos/${videoId}/source/0b5f6c2e-8a5d-4c3e-9f1a-2b3c4d5e6f70`,
      mimeType: 'video/mp4',
    };
    expect(transcodeJobSchema.safeParse(job).success).toBe(true);
    expect(transcodeJobSchema.safeParse({ ...job, sourceKey: '../../etc/passwd' }).success).toBe(
      false,
    );
    expect(
      transcodeJobSchema.safeParse({ ...job, sourceKey: `videos/${videoId}/hls/x` }).success,
    ).toBe(false);
  });
});

describe('transcodeResultSchema', () => {
  const ready = {
    type: 'ready',
    videoId,
    durationSeconds: 10,
    width: 1280,
    height: 720,
    hlsPrefix: prefix,
    masterKey: `${prefix}/master.m3u8`,
    posterKey: `${prefix}/poster.jpg`,
    renditions: [{ name: '720p', width: 1280, height: 720, bandwidth: 2_928_000 }],
  };

  it('accepts the three message types', () => {
    expect(transcodeResultSchema.safeParse({ type: 'started', videoId }).success).toBe(true);
    expect(transcodeResultSchema.safeParse(ready).success).toBe(true);
    expect(
      transcodeResultSchema.safeParse({ type: 'failed', videoId, reason: 'bad' }).success,
    ).toBe(true);
  });

  it('rejects keys outside the video prefix, odd rendition names and extra fields', () => {
    expect(
      transcodeResultSchema.safeParse({ ...ready, masterKey: 'videos/other/master.m3u8' }).success,
    ).toBe(false);
    expect(
      transcodeResultSchema.safeParse({
        ...ready,
        renditions: [{ name: '../x', width: 1, height: 1, bandwidth: 1 }],
      }).success,
    ).toBe(false);
    expect(transcodeResultSchema.safeParse({ ...ready, publish: true }).success).toBe(false);
    expect(transcodeResultSchema.safeParse({ type: 'failed', videoId, reason: '' }).success).toBe(
      false,
    );
  });
});
