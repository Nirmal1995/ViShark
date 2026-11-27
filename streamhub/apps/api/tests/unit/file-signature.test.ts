import { describe, expect, it } from 'vitest';
import { matchesDeclaredType } from '../../src/modules/uploads/file-signature.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);
const mp4 = bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
const mov = bytes(0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20);
const webm = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);

describe('matchesDeclaredType', () => {
  it('accepts files whose first bytes match the declared container', () => {
    expect(matchesDeclaredType(mp4, 'video/mp4')).toBe(true);
    expect(matchesDeclaredType(mov, 'video/quicktime')).toBe(true);
    // Phones label the same ISO media file either way.
    expect(matchesDeclaredType(mov, 'video/mp4')).toBe(true);
    expect(matchesDeclaredType(webm, 'video/webm')).toBe(true);
  });

  it('rejects other files, mismatched containers and truncated input', () => {
    expect(matchesDeclaredType(png, 'video/mp4')).toBe(false);
    expect(matchesDeclaredType(webm, 'video/mp4')).toBe(false);
    expect(matchesDeclaredType(mp4, 'video/webm')).toBe(false);
    expect(matchesDeclaredType(mp4.subarray(0, 6), 'video/mp4')).toBe(false);
    expect(matchesDeclaredType(new Uint8Array(), 'video/webm')).toBe(false);
  });
});
