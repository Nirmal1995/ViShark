import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * watchProgress: one document per user and video, overwritten by the
 * player's position reports. Powers "resume where you left off" and the
 * history list (newest first).
 */
const watchProgressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    videoId: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
    positionSeconds: { type: Number, required: true, min: 0 },
    completed: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, versionKey: false, collection: 'watchProgress' },
);
watchProgressSchema.index({ userId: 1, videoId: 1 }, { unique: true });
watchProgressSchema.index({ userId: 1, updatedAt: -1 });

export type WatchProgress = InferSchemaType<typeof watchProgressSchema>;
export const WatchProgressModel: Model<WatchProgress> =
  (mongoose.models.WatchProgress as Model<WatchProgress> | undefined) ??
  mongoose.model<WatchProgress>('WatchProgress', watchProgressSchema);

/** favourites: a user's saved videos. The unique index makes "add" idempotent. */
const favouriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    videoId: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
favouriteSchema.index({ userId: 1, videoId: 1 }, { unique: true });
favouriteSchema.index({ userId: 1, createdAt: -1 });

export type Favourite = InferSchemaType<typeof favouriteSchema>;
export const FavouriteModel: Model<Favourite> =
  (mongoose.models.Favourite as Model<Favourite> | undefined) ??
  mongoose.model<Favourite>('Favourite', favouriteSchema);
