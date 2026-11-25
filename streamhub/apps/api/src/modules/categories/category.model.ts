import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * categories collection. The slug (derived from the name) is unique, so
 * "Sci-Fi" and "sci fi" cannot both exist.
 */
const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    slug: { type: String, required: true, unique: true, maxlength: 60 },
    description: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

export type Category = InferSchemaType<typeof categorySchema>;
export type CategoryDocument = mongoose.HydratedDocument<Category>;
export const CategoryModel: Model<Category> =
  (mongoose.models.Category as Model<Category> | undefined) ??
  mongoose.model<Category>('Category', categorySchema);

/** "Science & Nature!" -> "science-nature". Letters and digits from any script are kept. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
