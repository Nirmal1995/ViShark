import { ensureSessionIndexes } from '../modules/auth/sessions.service.ts';
import { EmailVerificationTokenModel, PasswordResetTokenModel } from '../modules/auth/tokens.ts';
import { AuditLogModel } from '../modules/audit/audit.model.ts';
import { CategoryModel } from '../modules/categories/category.model.ts';
import { UserModel } from '../modules/users/user.model.ts';
import { VideoModel } from '../modules/videos/video.model.ts';

/**
 * Creates every index the application relies on (unique email, TTL indexes
 * for tokens, session lookups). Run automatically outside production; in
 * production it runs as a controlled migration step before deploying.
 */
export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    UserModel.createIndexes(),
    EmailVerificationTokenModel.createIndexes(),
    PasswordResetTokenModel.createIndexes(),
    ensureSessionIndexes(),
    CategoryModel.createIndexes(),
    VideoModel.createIndexes(),
    AuditLogModel.createIndexes(),
  ]);
}
