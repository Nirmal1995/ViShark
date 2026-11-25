import { describe, expect, it } from 'vitest';
import {
  PROCESSING_STATUSES,
  PUBLICATION_STATUSES,
  canTransitionProcessing,
  canTransitionPublication,
  processingStatesBefore,
  publicationStatesBefore,
} from './video-status.ts';

describe('processing transitions', () => {
  it('allows the happy path in order', () => {
    const path = ['INITIATED', 'UPLOADING', 'VERIFYING', 'PROCESSING', 'READY'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionProcessing(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('rejects skipping steps and going backwards', () => {
    expect(canTransitionProcessing('INITIATED', 'READY')).toBe(false);
    expect(canTransitionProcessing('UPLOADING', 'PROCESSING')).toBe(false);
    expect(canTransitionProcessing('READY', 'PROCESSING')).toBe(false);
  });

  it('treats READY, FAILED and ABORTED as final', () => {
    for (const end of ['READY', 'FAILED', 'ABORTED'] as const) {
      for (const to of PROCESSING_STATUSES) expect(canTransitionProcessing(end, to)).toBe(false);
    }
  });

  it('only allows aborting before verification starts', () => {
    expect(processingStatesBefore('ABORTED')).toEqual(['INITIATED', 'UPLOADING']);
  });
});

describe('publication transitions', () => {
  it('publishes only when processing is READY', () => {
    expect(canTransitionPublication('DRAFT', 'PUBLISHED', 'READY')).toBe(true);
    expect(canTransitionPublication('DRAFT', 'PUBLISHED', 'PROCESSING')).toBe(false);
    expect(canTransitionPublication('DRAFT', 'PUBLISHED', 'INITIATED')).toBe(false);
  });

  it('cannot publish an archived video without restoring it first', () => {
    expect(canTransitionPublication('ARCHIVED', 'PUBLISHED', 'READY')).toBe(false);
    expect(canTransitionPublication('ARCHIVED', 'DRAFT', 'READY')).toBe(true);
  });

  it('never transitions to the same state', () => {
    for (const s of PUBLICATION_STATUSES)
      expect(canTransitionPublication(s, s, 'READY')).toBe(false);
  });

  it('lists the states each target can be reached from', () => {
    expect(publicationStatesBefore('PUBLISHED')).toEqual(['DRAFT']);
    expect(publicationStatesBefore('ARCHIVED')).toEqual(['DRAFT', 'PUBLISHED']);
  });
});
