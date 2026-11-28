import { describe, expect, it } from 'vitest';
import { MAX_POSITION_SECONDS, progressBodySchema } from './playback.ts';

describe('progressBodySchema', () => {
  it('accepts fractional positions within a day', () => {
    expect(progressBodySchema.safeParse({ positionSeconds: 0 }).success).toBe(true);
    expect(progressBodySchema.safeParse({ positionSeconds: 754.2 }).success).toBe(true);
    expect(progressBodySchema.safeParse({ positionSeconds: MAX_POSITION_SECONDS }).success).toBe(
      true,
    );
  });

  it('rejects negative, huge, missing or extra values', () => {
    expect(progressBodySchema.safeParse({ positionSeconds: -0.1 }).success).toBe(false);
    expect(
      progressBodySchema.safeParse({ positionSeconds: MAX_POSITION_SECONDS + 1 }).success,
    ).toBe(false);
    expect(progressBodySchema.safeParse({}).success).toBe(false);
    expect(
      progressBodySchema.safeParse({ positionSeconds: 1, userId: '0123456789abcdef01234567' })
        .success,
    ).toBe(false);
  });
});
