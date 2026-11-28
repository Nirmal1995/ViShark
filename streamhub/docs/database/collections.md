# MongoDB Collections

Database: `streamhub` (application) and `streamhub_test` (integration tests only). The application connects as `streamhub_app` with `readWrite` on both, and nothing else.

Status: collections are added here as each phase introduces them.

## users

| Field                    | Type                      | Notes                                                                  |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `_id`                    | ObjectId                  |                                                                        |
| `email`                  | string                    | required, trimmed, lowercase, max 254, **unique index**                |
| `passwordHash`           | string                    | Argon2id encoded hash, `select: false` (never loaded unless asked for) |
| `displayName`            | string                    | required, max 60                                                       |
| `role`                   | `USER` \| `ADMIN`         | default `USER`                                                         |
| `status`                 | `ACTIVE` \| `DEACTIVATED` | default `ACTIVE`                                                       |
| `emailVerifiedAt`        | Date \| null              |                                                                        |
| `passwordChangedAt`      | Date \| null              | set by password change/reset (Phase 3b)                                |
| `lastLoginAt`            | Date \| null              | set when a sign-in completes (after the second factor if MFA is on)    |
| `mfa.enabledAt`          | Date \| null              | two-factor on since; the only MFA field loaded by default              |
| `mfa.secret`             | string \| null            | **encrypted** TOTP seed (`v1.` AES-256-GCM), `select: false`           |
| `mfa.pendingSecret`      | string \| null            | encrypted seed during enrolment, `select: false`                       |
| `mfa.pendingCreatedAt`   | Date \| null              | enrolment must be confirmed within 10 minutes, `select: false`         |
| `mfa.lastUsedStep`       | number                    | last accepted 30-second step (replay protection), `select: false`      |
| `mfa.recoveryCodeHashes` | string[]                  | HMAC-SHA256 of unused recovery codes, `select: false`                  |
| `createdAt`, `updatedAt` | Date                      | Mongoose timestamps                                                    |

Schema mode `strict: 'throw'`: writing an unknown field is an error, not silently dropped.

Indexes: `{ email: 1 }` unique.

API responses use `UserDto` (`id, email, displayName, role, emailVerified, mfaEnabled, createdAt`); the document is never returned directly.

## sessions

Managed by `connect-mongo` (`stringify: false`, so fields are queryable).

| Field                             | Type           | Notes                                                        |
| --------------------------------- | -------------- | ------------------------------------------------------------ |
| `_id`                             | string         | **SHA-256 of the session ID**, not the ID itself             |
| `expires`                         | Date           | idle-timeout expiry; **TTL index** removes expired documents |
| `lastModified`                    | Date           | used by connect-mongo `touchAfter`                           |
| `session.cookie`                  | object         | cookie settings                                              |
| `session.userId`                  | string         | owner                                                        |
| `session.handle`                  | string         | public random identifier for listing/revoking                |
| `session.csrfToken`               | string         | synchronizer token                                           |
| `session.createdAt`               | number (ms)    | absolute timeout                                             |
| `session.lastSeenAt`              | number (ms)    | idle timeout                                                 |
| `session.userAgent`, `session.ip` | string \| null | shown to the owner in "my sessions"                          |

Indexes: `{ expires: 1 }` TTL (`expireAfterSeconds: 0`, created by connect-mongo), `{ 'session.userId': 1 }` (list and revoke by user).

## emailVerificationTokens and passwordResetTokens

Same shape for both (one Mongoose model each, `src/modules/auth/tokens.ts`).

| Field       | Type     | Notes                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------ |
| `_id`       | ObjectId |                                                                          |
| `userId`    | ObjectId | owner; indexed                                                           |
| `tokenHash` | string   | **SHA-256 of the token**, unique; the token itself is only in the email  |
| `expiresAt` | Date     | verification 24 h, reset 30 min; **TTL index** (`expireAfterSeconds: 0`) |
| `createdAt` | Date     |                                                                          |

Lifecycle: issuing a token deletes the user's older tokens of that kind; using one deletes it atomically (`findOneAndDelete`); a successful reset deletes all of the user's reset tokens. Expired documents are removed by MongoDB within about a minute, and the query also rejects them, so the TTL delay is never a window.

## categories

| Field                    | Type     | Notes                                                                                                                                         |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id`                    | ObjectId |                                                                                                                                               |
| `name`                   | string   | 2 to 50 characters                                                                                                                            |
| `slug`                   | string   | derived from the name (`Science & Nature` -> `science-nature`); **unique**, so names that differ only in case, spacing or punctuation collide |
| `description`            | string   | up to 300 characters                                                                                                                          |
| `createdAt`, `updatedAt` | Date     |                                                                                                                                               |

At most 200 categories (the list endpoint returns them all, so the cap keeps it bounded). A category used by any non-deleted video cannot be deleted (`409 CATEGORY_IN_USE`).

## videos

Metadata only; the files live in private object storage under generated keys.

| Field                                | Type                   | Notes                                                                             |
| ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| `_id`                                | ObjectId               |                                                                                   |
| `title`                              | string                 | 1 to 120 characters                                                               |
| `description`                        | string                 | up to 5,000 characters                                                            |
| `ownerId`                            | ObjectId               | the administrator who created it (`users`)                                        |
| `categoryId`                         | ObjectId \| null       | `categories`                                                                      |
| `visibility`                         | enum                   | `PUBLIC` (listed) or `UNLISTED` (watchable by link only)                          |
| `publicationStatus`                  | enum                   | `DRAFT`, `PUBLISHED`, `ARCHIVED`                                                  |
| `processingStatus`                   | enum                   | `INITIATED`, `UPLOADING`, `VERIFYING`, `PROCESSING`, `READY`, `FAILED`, `ABORTED` |
| `storageKey`                         | string \| null         | object key of the original upload (Phase 4b); never returned by the API           |
| `thumbnailKey`                       | string \| null         | poster image in the media bucket (Phase 6); served as a signed URL                |
| `mimeType`, `sizeBytes`              | string, number \| null | verified after upload (Phase 4b)                                                  |
| `durationSeconds`, `width`, `height` | number \| null         | measured by the worker (Phase 6)                                                  |
| `failureReason`                      | string \| null         | short, operator-facing reason when processing failed                              |
| `hlsPrefix`, `hlsMasterKey`          | string \| null         | the worker's HLS output in the media bucket (Phase 6); never returned by the API  |
| `renditions`                         | array                  | `{ name, width, height, bandwidth }` per rendition, e.g. `720p`                   |
| `publishedAt`                        | Date \| null           | set on publish, cleared on unpublish                                              |
| `deletedAt`                          | Date \| null           | soft delete: excluded from every query; files removed by a cleanup job            |
| `createdAt`, `updatedAt`             | Date                   |                                                                                   |

Status changes follow the state machines in `packages/shared/src/video-status.ts` and are applied atomically: the update only matches a document in an allowed state, so concurrent or stale requests get `409 INVALID_TRANSITION` instead of overwriting each other.

| Index                                                            | Serves                                    |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `{ publicationStatus, visibility, categoryId, publishedAt: -1 }` | the catalogue (newest first, by category) |
| `{ categoryId, deletedAt }`                                      | "is this category in use"                 |
| `{ processingStatus, updatedAt }`                                | finding stuck uploads and jobs (4b, 6)    |
| `{ createdAt: -1 }`                                              | the management list                       |
| text index on `title` (weight 3) and `description`               | `q` search                                |

## uploads

One multipart upload per video (Phase 4b, ADR-044). The file goes from the browser straight to object storage; this document tracks the upload and its deadline.

| Field                    | Type     | Notes                                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| `videoId`                | ObjectId | unique: one upload per video, ever                                                |
| `createdBy`              | ObjectId | the administrator                                                                 |
| `bucket`, `key`          | string   | generated key `videos/<videoId>/source/<uuid>`; never returned by the API         |
| `storageUploadId`        | string   | the S3 multipart `UploadId`; server-side only                                     |
| `mimeType`               | string   | `video/mp4`, `video/quicktime` or `video/webm`                                    |
| `sizeBytes`              | number   | declared size; the stored object must match exactly                               |
| `partSizeBytes`          | number   | every part except the last has this size                                          |
| `partCount`              | number   |                                                                                   |
| `status`                 | string   | `ACTIVE`, `COMPLETING` (short claim), `COMPLETED`, `ABORTED`, `EXPIRED`, `FAILED` |
| `expiresAt`              | Date     | default 24 hours after start; the sweep expires it afterwards                     |
| `completedAt`            | Date     |                                                                                   |
| `failureReason`          | string   | why it was rejected or ended                                                      |
| `createdAt`, `updatedAt` | Date     |                                                                                   |

Indexes: `{ videoId }` unique, `{ status, expiresAt }` (the expiry sweep).

## watchProgress

One document per user and video, overwritten by the player's position reports (Phase 5, ADR-046).

| Field                    | Type     | Notes                                                           |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `userId`, `videoId`      | ObjectId | unique together                                                 |
| `positionSeconds`        | number   | clamped to the duration when it is known                        |
| `completed`              | boolean  | at 95% of the duration; a finished video resumes from the start |
| `createdAt`, `updatedAt` | Date     | `updatedAt` orders the history                                  |

Indexes: `{ userId, videoId }` unique, `{ userId, updatedAt: -1 }` (history, newest first).

## favourites

| Field               | Type     | Notes                                   |
| ------------------- | -------- | --------------------------------------- |
| `userId`, `videoId` | ObjectId | unique together, so "add" is idempotent |
| `createdAt`         | Date     | orders the list                         |

Indexes: `{ userId, videoId }` unique, `{ userId, createdAt: -1 }`.

History and favourites only list videos the user can still watch (published, `READY`, not deleted); the rest stay stored and reappear if a video is published again.

## auditLogs

Append-only record of privileged changes. The application never updates or deletes these documents.

| Field        | Type                       | Notes                                                                                                                  |
| ------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `actorId`    | ObjectId \| null           | the administrator; `null` for server-side tools                                                                        |
| `via`        | `api` \| `cli` \| `system` | `system`: background jobs such as upload expiry                                                                        |
| `action`     | string                     | for example `video.published`, `video.upload_completed`, `video.upload_rejected`, `admin.created`                      |
| `targetType` | string                     | `video`, `category`, `user`                                                                                            |
| `targetId`   | ObjectId \| null           |                                                                                                                        |
| `details`    | object                     | a few non-sensitive values chosen by the code (old and new status, a title); never request bodies, passwords or tokens |
| `requestId`  | string \| null             | links the record to the request logs                                                                                   |
| `ip`         | string \| null             |                                                                                                                        |
| `createdAt`  | Date                       |                                                                                                                        |

Indexes: `{ createdAt: -1 }`, `{ targetId, createdAt: -1 }`, `{ actorId, createdAt: -1 }`, `{ action, createdAt: -1 }`. No TTL: retention is a policy decision (for a real service, typically one year or more, archived to cheaper storage).

## Relationships

```
users 1 ──── * sessions                  (session.userId → users._id as string)
users 1 ──── * emailVerificationTokens   (userId)
users 1 ──── * passwordResetTokens       (userId)
videos 1 ─── 0..1 uploads                (videoId, unique)
users  1 ──── * watchProgress            (userId; one per video)
users  1 ──── * favourites               (userId; one per video)
users 1 ──── * videos                    (ownerId)
categories 1 ──── * videos               (categoryId)
users 1 ──── * auditLogs                 (actorId)
```

Collections still to come: uploads (Phase 4b), favourites and watchHistory (Phase 5).
