import { describe, expect, it } from 'vitest';
import { interpretProbe, InvalidMediaError } from '../../src/probe.ts';

const probeOutput = (streams: object[], duration = '12.5') =>
  JSON.stringify({ streams, format: { duration } });
const video = { codec_type: 'video', width: 1920, height: 1080 };
const audio = { codec_type: 'audio' };

describe('interpretProbe', () => {
  it('reads size, duration and audio', () => {
    expect(interpretProbe(probeOutput([video, audio]), 3600)).toEqual({
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
  });

  it('swaps width and height for videos recorded rotated by 90 degrees', () => {
    const rotated = { ...video, side_data_list: [{ rotation: -90 }] };
    expect(interpretProbe(probeOutput([rotated]), 3600)).toMatchObject({
      width: 1080,
      height: 1920,
      hasAudio: false,
    });
    const tagged = { ...video, tags: { rotate: '270' } };
    expect(interpretProbe(probeOutput([tagged]), 3600)).toMatchObject({ width: 1080 });
  });

  it('rejects files that are not usable videos', () => {
    const reject =
      (raw: string, max = 3600) =>
      () =>
        interpretProbe(raw, max);
    expect(reject('not json')).toThrow(InvalidMediaError);
    expect(reject(probeOutput([audio]))).toThrow(/no video stream/);
    // Cover art in an audio file is not a video.
    expect(reject(probeOutput([{ ...video, disposition: { attached_pic: 1 } }, audio]))).toThrow(
      /no video stream/,
    );
    expect(reject(probeOutput([{ codec_type: 'video', width: 8, height: 8 }]))).toThrow(
      /too small/,
    );
    expect(reject(probeOutput([video], 'N/A'))).toThrow(/duration/);
    expect(reject(probeOutput([video], '7200'), 3600)).toThrow(/3600 second limit/);
  });
});
