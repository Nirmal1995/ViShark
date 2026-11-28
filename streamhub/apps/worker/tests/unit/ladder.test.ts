import { describe, expect, it } from 'vitest';
import { masterPlaylist, planRenditions } from '../../src/ladder.ts';
import { renditionArgs } from '../../src/transcode.ts';

describe('planRenditions', () => {
  it('uses every step up to the source and never upscales', () => {
    const plan = planRenditions({ width: 1920, height: 1080 }, true);
    expect(plan.map((r) => [r.name, r.width, r.height])).toEqual([
      ['1080p', 1920, 1080],
      ['720p', 1280, 720],
      ['480p', 854, 480],
      ['360p', 640, 360],
    ]);
    expect(planRenditions({ width: 1280, height: 720 }, true).map((r) => r.name)).toEqual([
      '720p',
      '480p',
      '360p',
    ]);
    // 4K sources stop at 1080p; between steps, the step below is the highest.
    expect(planRenditions({ width: 3840, height: 2160 }, true)[0]!.name).toBe('1080p');
    expect(planRenditions({ width: 1000, height: 562 }, true)[0]!.name).toBe('480p');
  });

  it('treats the short side as "p", so portrait videos keep their quality', () => {
    const plan = planRenditions({ width: 1080, height: 1920 }, false);
    expect(plan[0]).toMatchObject({ name: '1080p', width: 1080, height: 1920 });
    expect(plan.at(-1)).toMatchObject({ name: '360p', width: 360, height: 640 });
  });

  it('gives a source below the lowest step one rendition at its own (even) size', () => {
    expect(planRenditions({ width: 321, height: 241 }, false)).toEqual([
      { name: '242p', width: 322, height: 242, videoKbps: 600, bandwidth: 600_000 },
    ]);
  });

  it('advertises video plus audio bandwidth', () => {
    expect(planRenditions({ width: 640, height: 360 }, true)[0]!.bandwidth).toBe(928_000);
    expect(planRenditions({ width: 640, height: 360 }, false)[0]!.bandwidth).toBe(800_000);
  });
});

describe('masterPlaylist', () => {
  it('lists every rendition, best first, with bandwidth and resolution', () => {
    const playlist = masterPlaylist(planRenditions({ width: 1280, height: 720 }, true));
    expect(playlist).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
        '720p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x480',
        '480p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360',
        '360p/index.m3u8',
        '',
      ].join('\n'),
    );
  });
});

describe('renditionArgs', () => {
  const [r] = planRenditions({ width: 640, height: 360 }, true);
  const args = renditionArgs('/w/source', '/w/out', r!, true, 'veryfast');

  it('scales to the planned size, caps the bitrate and aligns keyframes', () => {
    expect(args).toContain('scale=640:360:flags=lanczos,format=yuv420p');
    expect(args.join(' ')).toContain('-maxrate 800k -bufsize 1600k');
    expect(args).toContain('expr:gte(t,n_forced*2)');
    expect(args.join(' ')).toContain('-hls_time 6 -hls_playlist_type vod');
    expect(args.at(-1)).toBe('/w/out/360p/index.m3u8');
  });

  it('only maps and encodes audio when the source has it', () => {
    expect(args.join(' ')).toContain('-map 0:a:0');
    const silent = renditionArgs('/w/source', '/w/out', r!, false, 'veryfast').join(' ');
    expect(silent).not.toContain('0:a:0');
    expect(silent).not.toContain('-c:a');
  });
});
