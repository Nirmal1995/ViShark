import {
  adminVideoDtoSchema,
  adminVideosQuerySchema,
  auditLogDtoSchema,
  auditLogsQuerySchema,
  catalogueQuerySchema,
  catalogueVideoDtoSchema,
  categoryDtoSchema,
  createCategoryBodySchema,
  createVideoBodySchema,
  pageMetaSchema,
  updateCategoryBodySchema,
  updateVideoBodySchema,
  changePasswordBodySchema,
  deactivateAccountBodySchema,
  emailOnlyBodySchema,
  loginBodySchema,
  mfaDisableBodySchema,
  mfaEnableBodySchema,
  mfaRecoveryCodesBodySchema,
  mfaSetupBodySchema,
  mfaVerifyBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionDtoSchema,
  updateProfileBodySchema,
  userDtoSchema,
  verifyEmailBodySchema,
  completeUploadBodySchema,
  partUrlsDtoSchema,
  startUploadBodySchema,
  uploadDtoSchema,
  uploadPartUrlsBodySchema,
  uploadSessionDtoSchema,
} from '@streamhub/contracts';
import { z } from 'zod';

/**
 * OpenAPI 3.1 document. Component schemas are generated from the same Zod
 * schemas the API uses for validation (z.toJSONSchema), so documentation and
 * enforcement cannot drift apart. Each module adds its paths here.
 */
const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

const DependencyStatus = z.object({
  name: z.string().meta({ example: 'mongodb' }),
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int(),
});

const ReadinessReport = z.object({
  status: z.enum(['ready', 'not_ready']),
  draining: z.boolean(),
  dependencies: z.array(DependencyStatus),
});

const ApiInfo = z.object({
  data: z.object({
    name: z.string(),
    version: z.string(),
    apiVersion: z.literal('v1'),
    docs: z.string().nullable(),
  }),
});

/**
 * JSON Schema for a Zod schema. Request bodies are described as the client
 * sends them (io: 'input'), before normalising transforms such as removing
 * the dash from a recovery code.
 */
function schema(s: z.ZodType, io: 'input' | 'output' = 'output'): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, { target: 'draft-2020-12', io });
  return rest;
}
const body = (s: z.ZodType) => schema(s, 'input');

const REQUEST_ID = '9a1c0f5e-6f7e-4a1b-9a53-2a6b8e3d2f10';

/** A documented error response with a realistic example for each status. */
function errorResponse(description: string, code: string, message: string, details?: unknown) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorBody' },
        example: {
          error: { code, message, requestId: REQUEST_ID, ...(details ? { details } : {}) },
        },
      },
    },
  };
}

const json = (name: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dataOf = (inner: object) => ({
  'application/json': {
    schema: { type: 'object', properties: { data: inner }, required: ['data'] },
  },
});
const message = (example: string) =>
  dataOf({ type: 'object', properties: { message: { type: 'string', example } } });
const authenticated = [{ sessionCookie: [], csrfToken: [] }];
const sessionOnly = [{ sessionCookie: [] }];
const errors = (...statuses: string[]) =>
  Object.fromEntries(
    statuses.map((status) => [status, { $ref: `#/components/responses/E${status}` }]),
  );
const ACCEPTED = 'If an account exists for this email, we have sent instructions to it.';

/** Query parameters generated from a request schema, so docs and validation agree. */
function queryParams(s: z.ZodType) {
  const json = schema(s, 'input') as { properties?: Record<string, object> };
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name,
    in: 'query',
    required: false,
    schema: prop,
  }));
}
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-f0-9]{24}$' },
};
const pageOf = (name: string) => ({
  'application/json': {
    schema: {
      type: 'object',
      properties: { data: { type: 'array', items: ref(name) }, meta: ref('PageMeta') },
      required: ['data', 'meta'],
    },
  },
});
const INVALID_TRANSITION = errorResponse(
  'The video is not in a state that allows this change',
  'INVALID_TRANSITION',
  'This status change is not allowed',
  { to: 'PUBLISHED', publicationStatus: 'DRAFT', processingStatus: 'PROCESSING' },
);
const UPLOAD_NOT_ACTIVE = errorResponse(
  'The upload already finished, failed or was cancelled',
  'UPLOAD_NOT_ACTIVE',
  'This upload is no longer in progress',
  { status: 'COMPLETED' },
);
const UPLOAD_EXPIRED = errorResponse(
  'The upload passed its deadline',
  'UPLOAD_EXPIRED',
  'This upload has expired; create a new video to try again',
);

function videoTransition(summary: string, description: string) {
  return {
    post: {
      tags: ['videos'],
      summary,
      description,
      security: authenticated,
      parameters: [idParam],
      responses: {
        '200': { description: 'Updated video', content: dataOf(ref('AdminVideoDto')) },
        '409': INVALID_TRANSITION,
        ...errors('400', '401', '403', '404'),
      },
    },
  };
}

export function buildOpenApiDocument(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'StreamHub API',
      version,
      description: [
        'REST API for StreamHub. Endpoints under /api/v1 return `{ data }` on success and `{ error }` on failure; every response carries `X-Request-Id`.',
        '',
        '**Trying authenticated endpoints here:** run `POST /api/v1/auth/login`, copy `csrfToken` from the response, click **Authorize** and paste it into `csrfToken`. The session cookie is sent by the browser automatically.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'health', description: 'Liveness and readiness probes' },
      { name: 'meta', description: 'API information' },
      {
        name: 'auth',
        description: 'Registration, login, sessions, email verification and passwords',
      },
      { name: 'users', description: 'The signed-in user' },
      {
        name: 'mfa',
        description:
          'Two-factor authentication (TOTP authenticator apps). Enrolment is for administrators.',
      },
      { name: 'categories', description: 'Video categories (managed by administrators)' },
      {
        name: 'videos',
        description:
          'The catalogue for signed-in users, and video management for administrators. Status rules: publishing requires processing READY; see the error details of INVALID_TRANSITION.',
      },
      { name: 'admin', description: 'Administration: all videos, audit logs' },
      {
        name: 'uploads',
        description:
          'Direct-to-storage multipart uploads: start, PUT each part to its pre-signed URL (keep the ETag response header), then complete.',
      },
    ],
    paths: {
      '/health/live': {
        get: {
          tags: ['health'],
          summary: 'Liveness probe',
          description: 'Returns 200 while the process is running. Does not check dependencies.',
          responses: {
            '200': {
              description: 'Process is alive',
              content: { 'application/json': { example: { status: 'ok' } } },
            },
          },
        },
      },
      '/health/ready': {
        get: {
          tags: ['health'],
          summary: 'Readiness probe',
          description:
            'Checks MongoDB and Redis. Returns 503 if any is down or the instance is shutting down.',
          responses: {
            '200': { description: 'Ready to receive traffic', content: json('ReadinessReport') },
            '503': { description: 'Not ready', content: json('ReadinessReport') },
          },
        },
      },
      '/api/v1': {
        get: {
          tags: ['meta'],
          summary: 'API information',
          responses: { '200': { description: 'API name and version', content: json('ApiInfo') } },
        },
      },
      '/api/v1/auth/session': {
        get: {
          tags: ['auth'],
          summary: 'Current session',
          description:
            'Returns `authenticated: false` (plus `mfaPending: true` while a sign-in waits for its second factor), or the user and the CSRF token for this session.',
          responses: { '200': { description: 'Session state' } },
        },
      },
      '/api/v1/auth/register': {
        post: {
          tags: ['auth'],
          summary: 'Register',
          description:
            'Always 202 with the same body, whether or not the email is already registered (no account enumeration). New accounts receive a verification email; an existing owner receives a notice instead.',
          requestBody: { required: true, content: json('RegisterBody') },
          responses: {
            '202': {
              description: 'Accepted',
              content: message(
                'If this email can be registered, you will receive a verification email shortly.',
              ),
            },
            ...errors('400', '403', '429', '503'),
          },
        },
      },
      '/api/v1/auth/verify-email': {
        post: {
          tags: ['auth'],
          summary: 'Verify email address',
          description:
            'Consumes the single-use token from the verification email (the part after `#token=`).',
          requestBody: { required: true, content: json('VerifyEmailBody') },
          responses: {
            '200': {
              description: 'Verified',
              content: dataOf({ type: 'object', properties: { verified: { const: true } } }),
            },
            '400': errorResponse(
              'Invalid or expired token',
              'INVALID_TOKEN',
              'This link is invalid or has expired. Please request a new one.',
            ),
          },
        },
      },
      '/api/v1/auth/resend-verification': {
        post: {
          tags: ['auth'],
          summary: 'Resend the verification email',
          description: 'Always 202 with the same body. At most a few emails per address per hour.',
          requestBody: { required: true, content: json('EmailOnlyBody') },
          responses: {
            '202': { description: 'Accepted', content: message(ACCEPTED) },
            ...errors('400', '429'),
          },
        },
      },
      '/api/v1/auth/forgot-password': {
        post: {
          tags: ['auth'],
          summary: 'Request a password reset email',
          description:
            'Always 202 with the same body and timing, whether or not the account exists.',
          requestBody: { required: true, content: json('EmailOnlyBody') },
          responses: {
            '202': { description: 'Accepted', content: message(ACCEPTED) },
            ...errors('400', '429'),
          },
        },
      },
      '/api/v1/auth/reset-password': {
        post: {
          tags: ['auth'],
          summary: 'Set a new password with a reset token',
          description: 'Single-use token from the email. Signs out every session of the account.',
          requestBody: { required: true, content: json('ResetPasswordBody') },
          responses: {
            '200': {
              description: 'Password changed',
              content: message('Your password has been changed. Please sign in.'),
            },
            '400': errorResponse(
              'Invalid token or weak password',
              'INVALID_TOKEN',
              'This link is invalid or has expired. Please request a new one.',
            ),
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Log in',
          description:
            'Starts a new session (new session ID) and returns the CSRF token to send as `X-CSRF-Token` on later state-changing requests. Unknown email and wrong password give the same 401. Throttled per IP and per email.',
          requestBody: { required: true, content: json('LoginBody') },
          responses: {
            '200': {
              description:
                'Signed in (`mfaRequired: false`), or password accepted and a second factor is needed (`mfaRequired: true`, continue with `POST /auth/mfa/verify`)',
              content: dataOf({
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      mfaRequired: { const: false },
                      user: ref('UserDto'),
                      csrfToken: { type: 'string' },
                    },
                  },
                  { type: 'object', properties: { mfaRequired: { const: true } } },
                ],
              }),
            },
            '401': errorResponse(
              'Wrong email or password',
              'INVALID_CREDENTIALS',
              'Invalid email or password',
            ),
            '403': errorResponse(
              'Unverified or deactivated account',
              'EMAIL_NOT_VERIFIED',
              'Please verify your email address before signing in',
            ),
            ...errors('400', '429', '503'),
          },
        },
      },
      '/api/v1/auth/change-password': {
        post: {
          tags: ['auth'],
          summary: 'Change my password',
          description:
            'Requires the current password. Signs out other devices and starts a new session here: use the new `csrfToken` from the response.',
          security: authenticated,
          requestBody: { required: true, content: json('ChangePasswordBody') },
          responses: {
            '200': {
              description: 'Changed',
              content: dataOf({ type: 'object', properties: { csrfToken: { type: 'string' } } }),
            },
            '400': errorResponse(
              'Current password wrong or new password weak',
              'INVALID_CURRENT_PASSWORD',
              'The current password is incorrect',
            ),
            ...errors('401', '403'),
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Log out',
          security: authenticated,
          responses: { '204': { description: 'Session destroyed' }, ...errors('403') },
        },
      },
      '/api/v1/auth/sessions': {
        get: {
          tags: ['auth'],
          summary: 'List my sessions',
          security: sessionOnly,
          responses: {
            '200': {
              description: 'Sessions',
              content: dataOf({ type: 'array', items: ref('SessionDto') }),
            },
            ...errors('401'),
          },
        },
        delete: {
          tags: ['auth'],
          summary: 'Sign out all other devices',
          security: authenticated,
          responses: {
            '200': {
              description: 'Number of sessions revoked',
              content: dataOf({
                type: 'object',
                properties: { revoked: { type: 'integer', example: 2 } },
              }),
            },
            ...errors('401', '403'),
          },
        },
      },
      '/api/v1/auth/sessions/{handle}': {
        delete: {
          tags: ['auth'],
          summary: 'Revoke one of my sessions',
          security: authenticated,
          parameters: [
            {
              name: 'handle',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'Wg3NZ3rsEHhWp3qUWHuiTA' },
            },
          ],
          responses: { '204': { description: 'Revoked' }, ...errors('400', '401', '403', '404') },
        },
      },
      '/api/v1/auth/mfa/verify': {
        post: {
          tags: ['mfa', 'auth'],
          summary: 'Sign in, step 2: second factor',
          description:
            'After `POST /auth/login` returned `mfaRequired: true`. Send a 6-digit `code` from the authenticator app, or one `recoveryCode`. Each code works once. The pending sign-in expires after 5 minutes or 5 wrong codes.',
          requestBody: { required: true, content: json('MfaVerifyBody') },
          responses: {
            '200': {
              description: 'Signed in; new session cookie set',
              content: dataOf({
                type: 'object',
                properties: {
                  mfaRequired: { const: false },
                  user: ref('UserDto'),
                  csrfToken: { type: 'string' },
                },
              }),
            },
            '400': errorResponse(
              'Wrong or already used code',
              'INVALID_MFA_CODE',
              'The code is incorrect or has already been used',
            ),
            '401': errorResponse(
              'No pending sign-in, or it expired',
              'MFA_CHALLENGE_EXPIRED',
              'Your sign-in has expired. Please sign in again.',
            ),
            ...errors('429', '503'),
          },
        },
      },
      '/api/v1/auth/mfa/setup': {
        post: {
          tags: ['mfa'],
          summary: 'Start two-factor setup',
          description:
            'Administrators only. Requires the password. Returns the secret and an `otpauth://` URI to add to an authenticator app (shown once). Confirm with `POST /auth/mfa/enable` within 10 minutes.',
          security: authenticated,
          requestBody: { required: true, content: json('MfaSetupBody') },
          responses: {
            '200': {
              description: 'Secret for the authenticator app',
              content: dataOf({
                type: 'object',
                properties: {
                  secret: { type: 'string', example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
                  otpauthUri: {
                    type: 'string',
                    example:
                      'otpauth://totp/StreamHub:admin%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=StreamHub&algorithm=SHA1&digits=6&period=30',
                  },
                },
              }),
            },
            '409': errorResponse(
              'Already enabled',
              'MFA_ALREADY_ENABLED',
              'Two-factor authentication is already on',
            ),
            ...errors('400', '401', '403', '429'),
          },
        },
      },
      '/api/v1/auth/mfa/enable': {
        post: {
          tags: ['mfa'],
          summary: 'Confirm setup with a first code',
          description:
            'Turns two-factor on and returns 10 single-use recovery codes (shown once). Signs out other devices and starts a new session here: use the new `csrfToken`.',
          security: authenticated,
          requestBody: { required: true, content: json('MfaEnableBody') },
          responses: {
            '200': {
              description: 'Enabled',
              content: dataOf({
                type: 'object',
                properties: {
                  recoveryCodes: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['k7m2p-x9qr4', 'a3bc5-d6efg'],
                  },
                  csrfToken: { type: 'string' },
                },
              }),
            },
            '400': errorResponse(
              'Wrong code or setup expired',
              'INVALID_MFA_CODE',
              'The code is incorrect or has already been used',
            ),
            ...errors('401', '403', '429'),
          },
        },
      },
      '/api/v1/auth/mfa/disable': {
        post: {
          tags: ['mfa'],
          summary: 'Turn two-factor off',
          description: 'Requires the password and a current code or a recovery code.',
          security: authenticated,
          requestBody: { required: true, content: json('MfaDisableBody') },
          responses: {
            '204': { description: 'Disabled' },
            '400': errorResponse(
              'Wrong password or code',
              'INVALID_MFA_CODE',
              'The code is incorrect or has already been used',
            ),
            ...errors('401', '403', '429'),
          },
        },
      },
      '/api/v1/auth/mfa/recovery-codes': {
        post: {
          tags: ['mfa'],
          summary: 'Replace my recovery codes',
          description:
            'Requires the password and a current code. The old recovery codes stop working.',
          security: authenticated,
          requestBody: { required: true, content: json('MfaRecoveryCodesBody') },
          responses: {
            '200': {
              description: 'New recovery codes (shown once)',
              content: dataOf({
                type: 'object',
                properties: { recoveryCodes: { type: 'array', items: { type: 'string' } } },
              }),
            },
            '400': errorResponse(
              'Wrong password or code',
              'INVALID_MFA_CODE',
              'The code is incorrect or has already been used',
            ),
            ...errors('401', '403', '429'),
          },
        },
      },
      '/api/v1/categories': {
        get: {
          tags: ['categories'],
          summary: 'List categories',
          description: 'Sorted by name; at most 200.',
          security: sessionOnly,
          responses: {
            '200': {
              description: 'Categories',
              content: dataOf({ type: 'array', items: ref('CategoryDto') }),
            },
            ...errors('401', '403'),
          },
        },
        post: {
          tags: ['categories'],
          summary: 'Create a category',
          security: authenticated,
          requestBody: { required: true, content: json('CreateCategoryBody') },
          responses: {
            '201': { description: 'Created', content: dataOf(ref('CategoryDto')) },
            '409': errorResponse(
              'Name taken',
              'CATEGORY_EXISTS',
              'A category with this name already exists',
            ),
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/categories/{id}': {
        patch: {
          tags: ['categories'],
          summary: 'Rename or describe a category',
          security: authenticated,
          parameters: [idParam],
          requestBody: { required: true, content: json('UpdateCategoryBody') },
          responses: {
            '200': { description: 'Updated', content: dataOf(ref('CategoryDto')) },
            '409': errorResponse(
              'Name taken',
              'CATEGORY_EXISTS',
              'A category with this name already exists',
            ),
            ...errors('400', '401', '403', '404'),
          },
        },
        delete: {
          tags: ['categories'],
          summary: 'Delete a category',
          description: 'Refused while any video uses it.',
          security: authenticated,
          parameters: [idParam],
          responses: {
            '204': { description: 'Deleted' },
            '409': errorResponse(
              'Still in use',
              'CATEGORY_IN_USE',
              'The category is used by 3 video(s); move them to another category first',
            ),
            ...errors('400', '401', '403', '404'),
          },
        },
      },
      '/api/v1/videos': {
        get: {
          tags: ['videos'],
          summary: 'Browse the catalogue',
          description:
            'Published, processed, public videos, newest first. `q` searches titles and descriptions.',
          security: sessionOnly,
          parameters: queryParams(catalogueQuerySchema),
          responses: {
            '200': { description: 'A page of videos', content: pageOf('CatalogueVideoDto') },
            ...errors('400', '401', '403'),
          },
        },
        post: {
          tags: ['videos'],
          summary: 'Create a video (draft)',
          description:
            'Creates the metadata record. The file is uploaded afterwards (uploads, Phase 4b); until then processing is INITIATED.',
          security: authenticated,
          requestBody: { required: true, content: json('CreateVideoBody') },
          responses: {
            '201': { description: 'Created', content: dataOf(ref('AdminVideoDto')) },
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/videos/{id}': {
        get: {
          tags: ['videos'],
          summary: 'One video',
          description:
            'Viewers get published, processed videos (public or unlisted) and 404 for anything else. Administrators get any non-deleted video with management fields.',
          security: sessionOnly,
          parameters: [idParam],
          responses: {
            '200': {
              description: 'Video (AdminVideoDto for administrators)',
              content: dataOf(ref('CatalogueVideoDto')),
            },
            ...errors('400', '401', '404'),
          },
        },
        patch: {
          tags: ['videos'],
          summary: 'Edit video details',
          description:
            'Title, description, category and visibility only; statuses change through the action endpoints.',
          security: authenticated,
          parameters: [idParam],
          requestBody: { required: true, content: json('UpdateVideoBody') },
          responses: {
            '200': { description: 'Updated', content: dataOf(ref('AdminVideoDto')) },
            ...errors('400', '401', '403', '404'),
          },
        },
        delete: {
          tags: ['videos'],
          summary: 'Delete a video',
          description:
            'Soft delete: hidden everywhere immediately; files are removed by a cleanup job.',
          security: authenticated,
          parameters: [idParam],
          responses: { '204': { description: 'Deleted' }, ...errors('400', '401', '403', '404') },
        },
      },
      '/api/v1/videos/{id}/publish': videoTransition(
        'Publish',
        'From DRAFT, and only when processing is READY.',
      ),
      '/api/v1/videos/{id}/unpublish': videoTransition(
        'Unpublish',
        'From PUBLISHED back to DRAFT.',
      ),
      '/api/v1/videos/{id}/archive': videoTransition('Archive', 'From DRAFT or PUBLISHED.'),
      '/api/v1/videos/{id}/restore': videoTransition('Restore', 'From ARCHIVED back to DRAFT.'),
      '/api/v1/admin/videos': {
        get: {
          tags: ['admin', 'videos'],
          summary: 'All videos, any state',
          security: sessionOnly,
          parameters: queryParams(adminVideosQuerySchema),
          responses: {
            '200': { description: 'A page of videos', content: pageOf('AdminVideoDto') },
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/admin/videos/{id}/upload': {
        post: {
          tags: ['uploads'],
          summary: 'Start the upload',
          description:
            'For a video in INITIATED. Returns a pre-signed PUT URL per part; every part except the last must be exactly partSizeBytes. The video moves to UPLOADING. One upload per video.',
          security: authenticated,
          parameters: [idParam],
          requestBody: { required: true, content: json('StartUploadBody') },
          responses: {
            '201': { description: 'Upload started', content: dataOf(ref('UploadSessionDto')) },
            '409': INVALID_TRANSITION,
            '413': errorResponse(
              'File larger than allowed',
              'UPLOAD_TOO_LARGE',
              'The file is larger than allowed',
              { maxBytes: 2147483648 },
            ),
            ...errors('400', '401', '403', '404'),
          },
        },
        get: {
          tags: ['uploads'],
          summary: 'Upload status',
          security: sessionOnly,
          parameters: [idParam],
          responses: {
            '200': { description: 'The upload', content: dataOf(ref('UploadDto')) },
            ...errors('401', '403', '404'),
          },
        },
      },
      '/api/v1/admin/videos/{id}/upload/part-urls': {
        post: {
          tags: ['uploads'],
          summary: 'Fresh URLs for some parts',
          description: 'When part URLs expired before the parts were sent. At most 100 per call.',
          security: authenticated,
          parameters: [idParam],
          requestBody: { required: true, content: json('UploadPartUrlsBody') },
          responses: {
            '200': { description: 'Signed URLs', content: dataOf(ref('PartUrlsDto')) },
            '409': UPLOAD_NOT_ACTIVE,
            '410': UPLOAD_EXPIRED,
            ...errors('400', '401', '403', '404'),
          },
        },
      },
      '/api/v1/admin/videos/{id}/upload/complete': {
        post: {
          tags: ['uploads'],
          summary: 'Complete and verify the upload',
          description:
            'Send every part with its ETag. The API completes the multipart upload, then checks the stored size and the file signature. On success the video moves to VERIFYING; a wrong file is deleted and the video moves to FAILED.',
          security: authenticated,
          parameters: [idParam],
          requestBody: { required: true, content: json('CompleteUploadBody') },
          responses: {
            '200': { description: 'Upload completed', content: dataOf(ref('UploadDto')) },
            '409': UPLOAD_NOT_ACTIVE,
            '410': UPLOAD_EXPIRED,
            '422': errorResponse(
              'The file failed verification',
              'UPLOAD_VERIFICATION_FAILED',
              'The uploaded file was rejected',
              { reason: 'file content is not video/mp4' },
            ),
            ...errors('400', '401', '403', '404'),
          },
        },
      },
      '/api/v1/admin/videos/{id}/upload/abort': {
        post: {
          tags: ['uploads'],
          summary: 'Cancel the upload',
          description: 'Storage discards the parts; the video moves to ABORTED.',
          security: authenticated,
          parameters: [idParam],
          responses: {
            '200': { description: 'Upload cancelled', content: dataOf(ref('UploadDto')) },
            '409': UPLOAD_NOT_ACTIVE,
            ...errors('401', '403', '404'),
          },
        },
      },
      '/api/v1/admin/audit-logs': {
        get: {
          tags: ['admin'],
          summary: 'Audit log',
          description: 'Every privileged change, newest first.',
          security: sessionOnly,
          parameters: queryParams(auditLogsQuerySchema),
          responses: {
            '200': { description: 'A page of audit records', content: pageOf('AuditLogDto') },
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/users/me': {
        get: {
          tags: ['users'],
          summary: 'My profile',
          security: sessionOnly,
          responses: {
            '200': { description: 'Profile', content: dataOf(ref('UserDto')) },
            ...errors('401'),
          },
        },
        patch: {
          tags: ['users'],
          summary: 'Update my profile',
          security: authenticated,
          requestBody: { required: true, content: json('UpdateProfileBody') },
          responses: {
            '200': { description: 'Updated profile', content: dataOf(ref('UserDto')) },
            ...errors('400', '401', '403'),
          },
        },
      },
      '/api/v1/users/me/deactivate': {
        post: {
          tags: ['users'],
          summary: 'Deactivate my account',
          description:
            'Requires the password. Signs out every session; the account can no longer log in.',
          security: authenticated,
          requestBody: { required: true, content: json('DeactivateAccountBody') },
          responses: {
            '204': { description: 'Deactivated' },
            '400': errorResponse(
              'Wrong password',
              'INVALID_CURRENT_PASSWORD',
              'The password is incorrect',
            ),
            ...errors('401', '403'),
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorBody: schema(ErrorBody),
        ReadinessReport: schema(ReadinessReport),
        ApiInfo: schema(ApiInfo),
        RegisterBody: body(registerBodySchema),
        LoginBody: body(loginBodySchema),
        VerifyEmailBody: body(verifyEmailBodySchema),
        EmailOnlyBody: body(emailOnlyBodySchema),
        ResetPasswordBody: body(resetPasswordBodySchema),
        ChangePasswordBody: body(changePasswordBodySchema),
        DeactivateAccountBody: body(deactivateAccountBodySchema),
        UpdateProfileBody: body(updateProfileBodySchema),
        CreateCategoryBody: body(createCategoryBodySchema),
        UpdateCategoryBody: body(updateCategoryBodySchema),
        CreateVideoBody: body(createVideoBodySchema),
        UpdateVideoBody: body(updateVideoBodySchema),
        PageMeta: schema(pageMetaSchema),
        CategoryDto: schema(categoryDtoSchema),
        CatalogueVideoDto: schema(catalogueVideoDtoSchema),
        AdminVideoDto: schema(adminVideoDtoSchema),
        AuditLogDto: schema(auditLogDtoSchema),
        StartUploadBody: body(startUploadBodySchema),
        UploadPartUrlsBody: body(uploadPartUrlsBodySchema),
        CompleteUploadBody: body(completeUploadBodySchema),
        UploadDto: schema(uploadDtoSchema),
        UploadSessionDto: schema(uploadSessionDtoSchema),
        PartUrlsDto: schema(partUrlsDtoSchema),
        MfaSetupBody: body(mfaSetupBodySchema),
        MfaEnableBody: body(mfaEnableBodySchema),
        MfaVerifyBody: body(mfaVerifyBodySchema),
        MfaDisableBody: body(mfaDisableBodySchema),
        MfaRecoveryCodesBody: body(mfaRecoveryCodesBodySchema),
        UserDto: schema(userDtoSchema),
        SessionDto: schema(sessionDtoSchema),
      },
      responses: {
        E400: errorResponse('Validation failed', 'BAD_REQUEST', 'Request validation failed', [
          { location: 'body', path: 'password', message: 'must be at least 12 characters' },
        ]),
        E401: errorResponse(
          'Not signed in, or the session expired',
          'UNAUTHENTICATED',
          'Authentication required',
        ),
        E403: errorResponse(
          'Forbidden or CSRF check failed',
          'CSRF_FAILED',
          'Missing or invalid CSRF token',
        ),
        E404: errorResponse('Not found', 'NOT_FOUND', 'Session not found'),
        E429: errorResponse(
          'Too many requests (see Retry-After)',
          'TOO_MANY_REQUESTS',
          'Too many requests, please try again later',
        ),
        E500: errorResponse(
          'Unexpected server error',
          'INTERNAL_ERROR',
          'An unexpected error occurred',
        ),
        E503: errorResponse(
          'A dependency is unavailable',
          'SERVICE_UNAVAILABLE',
          'Service temporarily unavailable, please retry shortly',
        ),
      },
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'streamhub.sid' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
    },
  };
}
