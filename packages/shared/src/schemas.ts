import { z } from "zod";

export const NotebookCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.string().trim().min(1).nullable().optional(),
});

export const NotebookUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const MemoCreateSchema = z.object({
  notebookId: z.string().trim().min(1),
  title: z.string().trim().max(160).optional(),
  contentMarkdown: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const MemoUpdateSchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
  notebookId: z.string().trim().min(1).optional(),
  title: z.string().trim().max(160).optional(),
  contentJson: z.unknown().optional(),
  contentMarkdown: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const MergeMemosSchema = z.object({
  memoIds: z.array(z.string().trim().min(1)).min(2).max(50),
  notebookId: z.string().trim().min(1).optional(),
  title: z.string().trim().max(160).optional(),
});

export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(512),
});

export const ApiTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().trim().min(1).max(80)).min(1).max(32),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const TagRenameSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type NotebookCreateInput = z.infer<typeof NotebookCreateSchema>;
export type NotebookUpdateInput = z.infer<typeof NotebookUpdateSchema>;
export type MemoCreateInput = z.infer<typeof MemoCreateSchema>;
export type MemoUpdateInput = z.infer<typeof MemoUpdateSchema>;
export type MergeMemosInput = z.infer<typeof MergeMemosSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type ApiTokenCreateInput = z.infer<typeof ApiTokenCreateSchema>;
export type TagRenameInput = z.infer<typeof TagRenameSchema>;
