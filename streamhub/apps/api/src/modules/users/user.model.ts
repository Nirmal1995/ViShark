import { ROLES, type Role } from '@streamhub/shared';
import mongoose, { Schema, type InferSchemaType, type Model, type Types } from 'mongoose';

export const USER_STATUSES = ['ACTIVE', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * users collection. Email is stored normalised (trimmed, lowercase) and is
 * unique. passwordHash is excluded from queries by default (select: false),
 * so it can only leave the database when a query explicitly asks for it.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    role: { type: String, enum: ROLES, required: true, default: 'USER' },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'ACTIVE' },
    emailVerifiedAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    /**
     * Two-factor authentication (TOTP). Everything secret is excluded from
     * queries by default and the seeds are encrypted (secret-box.ts).
     */
    mfa: {
      enabledAt: { type: Date, default: null },
      /** Encrypted seed of the active authenticator. */
      secret: { type: String, default: null, select: false },
      /** Encrypted seed during enrolment, until the first code confirms it. */
      pendingSecret: { type: String, default: null, select: false },
      pendingCreatedAt: { type: Date, default: null, select: false },
      /** Highest time step accepted so far: a code is never accepted twice. */
      lastUsedStep: { type: Number, default: 0, select: false },
      /** SHA-256 hashes of unused recovery codes. */
      recoveryCodeHashes: { type: [String], default: [], select: false },
    },
  },
  {
    timestamps: true,
    strict: 'throw',
    collection: 'users',
  },
);

export type UserDocument = InferSchemaType<typeof userSchema> & {
  _id: Types.ObjectId;
  role: Role;
  status: UserStatus;
};

export const UserModel: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument> | undefined) ??
  mongoose.model<UserDocument>('User', userSchema);
