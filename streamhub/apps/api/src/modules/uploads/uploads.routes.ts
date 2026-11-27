import {
  completeUploadBodySchema,
  idParamsSchema,
  startUploadBodySchema,
  uploadPartUrlsBodySchema,
  type CompleteUploadBody,
  type StartUploadBody,
  type UploadPartUrlsBody,
} from '@streamhub/contracts';
import { Router } from 'express';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { validate } from '../../middleware/validate.ts';
import { audit } from '../audit/audit.service.ts';
import type { UploadsService } from './uploads.service.ts';

type IdParams = { params: { id: string } };

/**
 * /admin/videos/:id/upload: the upload workflow for one video. Only for
 * `video:manage`. The file itself never passes through the API.
 */
export function uploadsRouter(uploads: UploadsService): Router {
  const router = Router();
  const manage = [requireAuth, requirePermission('video:manage')];

  router.post(
    '/videos/:id/upload',
    ...manage,
    validate({ params: idParamsSchema, body: startUploadBodySchema }),
    async (req, res) => {
      const { params, body } = res.locals.validated as IdParams & { body: StartUploadBody };
      const session = await uploads.start(req.user!._id, params.id, body);
      await audit(req, {
        action: 'video.upload_started',
        targetType: 'video',
        targetId: params.id,
        details: { sizeBytes: body.sizeBytes, mimeType: body.mimeType, parts: session.partCount },
      });
      res.status(201).json(ok(session));
    },
  );

  router.get(
    '/videos/:id/upload',
    ...manage,
    validate({ params: idParamsSchema }),
    async (_req, res) => {
      const { params } = res.locals.validated as IdParams;
      res.json(ok(await uploads.get(params.id)));
    },
  );

  router.post(
    '/videos/:id/upload/part-urls',
    ...manage,
    validate({ params: idParamsSchema, body: uploadPartUrlsBodySchema }),
    async (_req, res) => {
      const { params, body } = res.locals.validated as IdParams & { body: UploadPartUrlsBody };
      res.json(ok(await uploads.partUrls(params.id, body.partNumbers)));
    },
  );

  router.post(
    '/videos/:id/upload/complete',
    ...manage,
    validate({ params: idParamsSchema, body: completeUploadBodySchema }),
    async (req, res) => {
      const { params, body } = res.locals.validated as IdParams & { body: CompleteUploadBody };
      const upload = await uploads.complete(params.id, body);
      await audit(req, {
        action: 'video.upload_completed',
        targetType: 'video',
        targetId: params.id,
        details: { sizeBytes: upload.sizeBytes },
      });
      res.json(ok(upload));
    },
  );

  router.post(
    '/videos/:id/upload/abort',
    ...manage,
    validate({ params: idParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as IdParams;
      const upload = await uploads.abort(params.id);
      await audit(req, {
        action: 'video.upload_aborted',
        targetType: 'video',
        targetId: params.id,
      });
      res.json(ok(upload));
    },
  );

  return router;
}
