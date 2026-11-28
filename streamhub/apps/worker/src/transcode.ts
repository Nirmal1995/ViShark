import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterPlaylist, type PlannedRendition } from './ladder.ts';
import { run } from './process.ts';

/** HLS segment length: a common VOD choice (quick start, few files). */
export const SEGMENT_SECONDS = 6;
/** Keyframe every 2 seconds, so every segment starts on one and renditions line up. */
const KEYFRAME_SECONDS = 2;

export interface TranscodeOptions {
  preset: string;
  timeoutSeconds: number;
}

/**
 * FFmpeg arguments for one rendition. Exported for tests: the command is the
 * part most worth reviewing (no upscaling, aligned keyframes, VOD playlist).
 */
export function renditionArgs(
  source: string,
  outDir: string,
  r: PlannedRendition,
  hasAudio: boolean,
  preset: string,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    source,
    '-map',
    '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []),
    // Exact even dimensions from the plan; FFmpeg applies the source's rotation first.
    '-vf',
    `scale=${r.width}:${r.height}:flags=lanczos,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-profile:v',
    'main',
    '-crf',
    '21',
    '-maxrate',
    `${r.videoKbps}k`,
    '-bufsize',
    `${r.videoKbps * 2}k`,
    '-force_key_frames',
    `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`,
    '-sc_threshold',
    '0',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : []),
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_type',
    'mpegts',
    '-hls_segment_filename',
    join(outDir, r.name, 'seg_%05d.ts'),
    join(outDir, r.name, 'index.m3u8'),
  ];
}

/** Transcodes every rendition, then writes the poster and the master playlist into outDir. */
export async function transcodeToHls(
  source: string,
  outDir: string,
  renditions: PlannedRendition[],
  media: { durationSeconds: number; hasAudio: boolean },
  options: TranscodeOptions,
): Promise<{ masterFile: string; posterFile: string }> {
  // One FFmpeg run per rendition: simpler to reason about and to fail cleanly
  // than one run with a split filter graph; decoding twice is the price.
  for (const r of renditions) {
    await mkdir(join(outDir, r.name), { recursive: true });
    await run(
      'ffmpeg',
      renditionArgs(source, outDir, r, media.hasAudio, options.preset),
      options.timeoutSeconds,
    );
  }

  const posterFile = join(outDir, 'poster.jpg');
  const largest = renditions[0]!;
  const at = Math.min(media.durationSeconds * 0.1, 10);
  await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-ss',
      at.toFixed(3),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=${largest.width}:${largest.height}`,
      '-q:v',
      '3',
      posterFile,
    ],
    options.timeoutSeconds,
  );

  const masterFile = join(outDir, 'master.m3u8');
  await writeFile(masterFile, masterPlaylist(renditions));
  return { masterFile, posterFile };
}
