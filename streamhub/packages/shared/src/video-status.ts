/**
 * Video lifecycle rules, shared by the API (which enforces them) and the web
 * app (which uses them to decide which buttons to show).
 *
 * Two independent state machines:
 *
 * Processing (what the system has done with the file):
 *
 *   INITIATED ──► UPLOADING ──► VERIFYING ──► PROCESSING ──► READY
 *       │             │             │              │
 *       └─────────────┴──► ABORTED  └──────────────┴──► FAILED
 *       (INITIATED and UPLOADING can also fail)
 *
 * Publication (what viewers may see):
 *
 *   DRAFT ◄──► PUBLISHED      DRAFT/PUBLISHED ──► ARCHIVED ──► DRAFT (restore)
 *   Publishing additionally requires processing READY.
 *
 * Anything not listed is rejected, so a bug or a crafted request cannot jump,
 * for example, from INITIATED straight to READY.
 */
export const PROCESSING_STATUSES = [
  'INITIATED',
  'UPLOADING',
  'VERIFYING',
  'PROCESSING',
  'READY',
  'FAILED',
  'ABORTED',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const PUBLICATION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** PUBLIC: listed in the catalogue. UNLISTED: watchable by link, never listed. */
export const VISIBILITIES = ['PUBLIC', 'UNLISTED'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

const PROCESSING_TRANSITIONS: Readonly<Record<ProcessingStatus, readonly ProcessingStatus[]>> = {
  INITIATED: ['UPLOADING', 'ABORTED', 'FAILED'],
  UPLOADING: ['VERIFYING', 'ABORTED', 'FAILED'],
  VERIFYING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['READY', 'FAILED'],
  READY: [],
  FAILED: [],
  ABORTED: [],
};

const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export function canTransitionProcessing(from: ProcessingStatus, to: ProcessingStatus): boolean {
  return PROCESSING_TRANSITIONS[from].includes(to);
}

/** The processing states a video must be in to move to `to`. */
export function processingStatesBefore(to: ProcessingStatus): ProcessingStatus[] {
  return PROCESSING_STATUSES.filter((from) => PROCESSING_TRANSITIONS[from].includes(to));
}

export function canTransitionPublication(
  from: PublicationStatus,
  to: PublicationStatus,
  processing: ProcessingStatus,
): boolean {
  if (!PUBLICATION_TRANSITIONS[from].includes(to)) return false;
  return to !== 'PUBLISHED' || processing === 'READY';
}

/** The publication states a video must be in to move to `to`. */
export function publicationStatesBefore(to: PublicationStatus): PublicationStatus[] {
  return PUBLICATION_STATUSES.filter((from) => PUBLICATION_TRANSITIONS[from].includes(to));
}
