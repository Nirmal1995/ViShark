import type { VideoMimeType } from '@streamhub/contracts';

/**
 * Checks a file's first bytes ("magic numbers") against the declared type.
 * The declared MIME type comes from the browser and proves nothing; the bytes
 * at least show the file is the container it claims to be. Full validation
 * (can it actually be decoded?) is ffprobe's job in the worker.
 */

/** Bytes to read from the start of the object. */
export const SIGNATURE_BYTES = 64;

type Container = 'iso-bmff' | 'matroska';

function detectContainer(bytes: Uint8Array): Container | null {
  // MP4 and QuickTime (ISO base media): a box size, then "ftyp" at offset 4.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  ) {
    return 'iso-bmff';
  }
  // WebM (a Matroska profile): EBML header 1A 45 DF A3.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'matroska';
  }
  return null;
}

const EXPECTED: Record<VideoMimeType, Container> = {
  // MP4 and QuickTime share the container format; phones label the same file
  // either way, so both are accepted for either type.
  'video/mp4': 'iso-bmff',
  'video/quicktime': 'iso-bmff',
  'video/webm': 'matroska',
};

export function matchesDeclaredType(bytes: Uint8Array, mimeType: VideoMimeType): boolean {
  return detectContainer(bytes) === EXPECTED[mimeType];
}
