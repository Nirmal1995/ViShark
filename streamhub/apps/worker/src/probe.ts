import { run } from './process.ts';

/** What the worker needs to know about a source file. */
export interface ProbeResult {
  durationSeconds: number;
  /** Display size: already swapped for phone videos recorded rotated by 90 degrees. */
  width: number;
  height: number;
  hasAudio: boolean;
}

/** The file cannot be processed, whatever we retry: bad, unsupported or too long. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/** Pure part of probing, unit-tested with captured ffprobe output. */
export function interpretProbe(raw: string, maxDurationSeconds: number): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(raw) as FfprobeOutput;
  } catch {
    throw new InvalidMediaError('ffprobe returned unreadable output');
  }
  const streams = parsed.streams ?? [];
  // Cover art in audio files is a "video" stream with attached_pic: not a video.
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video?.width || !video.height) throw new InvalidMediaError('no video stream');
  if (video.width < 16 || video.height < 16) throw new InvalidMediaError('video is too small');

  const duration = Number(parsed.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new InvalidMediaError('could not determine the duration');
  }
  if (duration > maxDurationSeconds) {
    throw new InvalidMediaError(`longer than the ${maxDurationSeconds} second limit`);
  }

  const rotation = Math.abs(
    Number(
      video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        video.tags?.rotate ??
        0,
    ),
  );
  const sideways = rotation % 180 === 90;
  return {
    durationSeconds: Math.round(duration * 1000) / 1000,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probe(
  file: string,
  maxDurationSeconds: number,
  timeoutSeconds: number,
): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      timeoutSeconds,
    ));
  } catch (err) {
    // ffprobe refusing the file is a property of the file, not a transient error.
    throw new InvalidMediaError(`not a readable video (${(err as Error).message})`);
  }
  return interpretProbe(stdout, maxDurationSeconds);
}
