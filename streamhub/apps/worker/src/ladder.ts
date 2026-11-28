import type { Rendition } from '@streamhub/contracts';

/**
 * The rendition ladder. "p" is the short side, so portrait phone videos get
 * the same quality steps as landscape ones. Rates are video peaks (maxrate);
 * x264 runs in capped CRF, so simple scenes use less.
 */
export const LADDER = [
  { p: 1080, videoKbps: 5000 },
  { p: 720, videoKbps: 2800 },
  { p: 480, videoKbps: 1400 },
  { p: 360, videoKbps: 800 },
] as const;

export const AUDIO_KBPS = 128;

export interface PlannedRendition extends Rendition {
  videoKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Picks the renditions for a source: every ladder step at or below the source
 * resolution, never above it (no upscaling). A source smaller than the
 * lowest step gets a single rendition at its own size.
 */
export function planRenditions(
  source: { width: number; height: number },
  hasAudio: boolean,
): PlannedRendition[] {
  const shortSide = Math.min(source.width, source.height);
  const steps: { p: number; videoKbps: number }[] = LADDER.filter((s) => s.p <= shortSide);
  if (steps.length === 0) steps.push({ p: even(shortSide), videoKbps: 600 });

  const landscape = source.width >= source.height;
  return steps.map(({ p, videoKbps }) => {
    const scale = p / shortSide;
    const width = landscape ? even(source.width * scale) : p;
    const height = landscape ? p : even(source.height * scale);
    return {
      name: `${p}p`,
      width,
      height,
      videoKbps,
      bandwidth: (videoKbps + (hasAudio ? AUDIO_KBPS : 0)) * 1000,
    };
  });
}

/** The master playlist: one entry per rendition, best first. */
export function masterPlaylist(renditions: Rendition[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of [...renditions].sort((a, b) => b.bandwidth - a.bandwidth)) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height}`);
    lines.push(`${r.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}
