import {
  createExcerpt,
  docToMarkdown,
  docToText,
  emptyDoc,
  ApiTokenCreateSchema,
  LoginSchema,
  markdownToDoc,
  MemoCreateSchema,
  MemoUpdateSchema,
  MergeMemosSchema,
  normalizeTags,
  TagRenameSchema,
  NotebookCreateSchema,
  NotebookUpdateSchema,
  type ApiToken,
  type CreatedApiToken,
  type MemoDetail,
  type MemoRevision,
  type MemoSummary,
  type Notebook,
  type Resource,
  type ResourceListItem,
  type ResourceStorageSummary,
  type TagSummary,
  type TiptapDoc,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";

type Bindings = {
  DB: D1Database;
  RESOURCES: R2Bucket;
  EDGE_EVER_AUTH_USERNAME?: string;
  EDGE_EVER_AUTH_PASSWORD_HASH?: string;
  EDGE_EVER_SESSION_TTL_DAYS?: string;
  EDGE_EVER_R2_BUCKET_NAME?: string;
};

type AuthContext = {
  kind: "user" | "agent";
  actorType: "user" | "agent";
  actorId: string | null;
  username: string;
  displayName: string | null;
  scopes: string[];
  sessionId?: string;
  tokenId?: string;
};

type NotebookRow = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type MemoSummaryRow = {
  id: string;
  notebook_id: string;
  title: string | null;
  excerpt: string;
  tags_json: string;
  is_pinned: number;
  is_archived: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  revision: number;
};

type MemoDetailRow = MemoSummaryRow & {
  content_json: string;
  content_markdown: string;
  content_text: string;
  source_memo_ids: string;
  merge_source_count: number;
  merged_into_memo_id: string | null;
  content_hash: string;
};

type MemoRevisionRow = {
  id: string;
  memo_id: string;
  revision: number;
  title: string | null;
  tags_json: string;
  content_json: string;
  content_markdown: string;
  content_text: string;
  content_hash: string;
  created_by: string;
  created_at: string;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  is_disabled: number;
};

type SessionRow = {
  id: string;
  user_id: string;
  username: string;
  display_name: string | null;
  expires_at: string;
};

type ApiTokenRow = {
  id: string;
  name: string;
  scopes_json: string;
  last_used_at: string | null;
  expires_at: string | null;
  is_revoked: number;
  created_at: string;
};

type TagSummaryRow = {
  name: string;
  memo_count: number;
  updated_at: string | null;
};

type MemoTagUpdateRow = {
  id: string;
  title: string | null;
  tags_json: string;
  content_text: string;
};

type ResourceRow = {
  id: string;
  memo_id: string;
  original_memo_id: string | null;
  bucket_name: string;
  object_key: string;
  kind: "image" | "attachment";
  mime_type: string | null;
  filename: string | null;
  byte_size: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
};

type ResourceListRow = ResourceRow & {
  memo_title: string | null;
  memo_excerpt: string | null;
  memo_is_deleted: number | null;
};

type ResourceStatsRow = {
  total_count: number;
  total_bytes: number;
  image_count: number;
  attachment_count: number;
};

type AppContext = Context<{ Bindings: Bindings; Variables: { auth: AuthContext } }>;

const SESSION_COOKIE = "edgeever_session";
const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_R2_BUCKET_NAME = "edgeever-resources";
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const REVISION_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const API_TOKEN_BYTES = 32;
const API_TOKEN_PREFIX = "eev";
const ALL_TOKEN_SCOPES = [
  "read:notebooks",
  "write:notebooks",
  "read:memos",
  "write:memos",
  "read:resources",
  "write:resources",
  "read:tags",
  "write:tags",
] as const;
type TokenScope = (typeof ALL_TOKEN_SCOPES)[number];
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const app = new Hono<{ Bindings: Bindings; Variables: { auth: AuthContext } }>();

app.use(
  "/api/*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

app.use(
  "/mcp",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    name: "edgeever",
    runtime: "cloudflare-workers",
  })
);

app.get("/api/v1/auth/session", async (c) => {
  const authRequired = await isAuthRequired(c.env);

  if (!authRequired) {
    return c.json({
      authRequired: false,
      authenticated: true,
      user: {
        id: "local",
        username: "owner",
        displayName: "Owner",
      },
    });
  }

  const auth = await authenticateRequest(c, false);

  return c.json({
    authRequired: true,
    authenticated: Boolean(auth && auth.kind === "user"),
    user:
      auth && auth.kind === "user"
        ? {
            id: auth.actorId,
            username: auth.username,
            displayName: auth.displayName,
          }
        : null,
  });
});

app.post("/api/v1/auth/login", zValidator("json", LoginSchema), async (c) => {
  const input = c.req.valid("json");
  const user = await verifyLogin(c.env, input.username, input.password);

  if (!user) {
    return unauthorized(c, "Username or password is incorrect.");
  }

  const session = await createSession(c, user);
  setSessionCookie(c, session.token, session.maxAge);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).bind(
      isoNow(),
      isoNow(),
      user.id
    ),
    auditStatement(c.env.DB, "user", user.id, "auth.login", "session", session.id, {
      username: user.username,
    }),
  ]);

  return c.json({
    authRequired: true,
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
    },
  });
});

app.post("/api/v1/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);

  if (token) {
    await revokeSession(c.env.DB, token);
  }

  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/v1/*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/auth/")) {
    await next();
    return;
  }

  const authRequired = await isAuthRequired(c.env);

  if (!authRequired) {
    c.set("auth", {
      kind: "user",
      actorType: "user",
      actorId: null,
      username: "owner",
      displayName: "Owner",
      scopes: [],
    });
    await next();
    return;
  }

  const auth = await authenticateRequest(c, true);

  if (!auth) {
    return unauthorized(c, "Authentication required.");
  }

  c.set("auth", auth);
  await next();
});

app.get("/api/v1/api-tokens", async (c) => {
  const userOnly = requireUser(c);

  if (userOnly) {
    return userOnly;
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, name, scopes_json, last_used_at, expires_at, is_revoked, created_at
     FROM api_tokens
     ORDER BY is_revoked ASC, created_at DESC
     LIMIT 200`
  ).all<ApiTokenRow>();

  return c.json({
    apiTokens: rows.results.map(mapApiToken),
    availableScopes: ALL_TOKEN_SCOPES,
  });
});

app.post("/api/v1/api-tokens", zValidator("json", ApiTokenCreateSchema), async (c) => {
  const userOnly = requireUser(c);

  if (userOnly) {
    return userOnly;
  }

  const input = c.req.valid("json");
  const scopes = normalizeTokenScopes(input.scopes);

  if (!scopes) {
    return badRequest(c, "Token scope is not supported.");
  }

  const id = createId("tok");
  const token = `${API_TOKEN_PREFIX}_${randomToken(API_TOKEN_BYTES)}`;
  const now = isoNow();
  const actor = getAuditActor(c);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO api_tokens (id, name, token_hash, scopes_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, input.name, await sha256(token), JSON.stringify(scopes), input.expiresAt ?? null, now),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "api_token.create", "api_token", id, {
      name: input.name,
      scopes,
      expiresAt: input.expiresAt ?? null,
    }),
  ]);

  const row = await getApiTokenRow(c.env.DB, id);

  if (!row) {
    return notFound(c, "API token not found");
  }

  return c.json({ token, apiToken: mapApiToken(row) } satisfies CreatedApiToken, 201);
});

app.delete("/api/v1/api-tokens/:id", async (c) => {
  const userOnly = requireUser(c);

  if (userOnly) {
    return userOnly;
  }

  const id = c.req.param("id");
  const actor = getAuditActor(c);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE api_tokens SET is_revoked = 1 WHERE id = ?`).bind(id),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "api_token.revoke", "api_token", id, {}),
  ]);

  return c.json({ ok: true });
});

app.get("/api/v1/notebooks", async (c) => {
  const denied = requireScopes(c, "read:notebooks");

  if (denied) {
    return denied;
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at
     FROM notebooks
     WHERE is_deleted = 0
     ORDER BY parent_id IS NOT NULL, sort_order ASC, name ASC`
  ).all<NotebookRow>();

  return c.json({ notebooks: rows.results.map(mapNotebook) });
});

app.post("/api/v1/notebooks", zValidator("json", NotebookCreateSchema), async (c) => {
  const denied = requireScopes(c, "write:notebooks");

  if (denied) {
    return denied;
  }

  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const id = createId("nb");
  const now = isoNow();

  await c.env.DB.prepare(
    `INSERT INTO notebooks (id, parent_id, name, slug, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, input.parentId ?? null, input.name, slugify(input.name), Date.now(), now, now)
    .run();

  const notebook = await getNotebook(c.env.DB, id);
  await audit(c.env.DB, actor.actorType, actor.actorId, "notebook.create", "notebook", id, { name: input.name });

  return c.json({ notebook }, 201);
});

app.patch("/api/v1/notebooks/:id", zValidator("json", NotebookUpdateSchema), async (c) => {
  const denied = requireScopes(c, "write:notebooks");

  if (denied) {
    return denied;
  }

  const id = c.req.param("id");
  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const current = await getNotebook(c.env.DB, id);

  if (!current) {
    return notFound(c, "Notebook not found");
  }

  const nextName = input.name ?? current.name;
  const nextParentId = input.parentId === undefined ? current.parentId : input.parentId;
  const nextSortOrder = input.sortOrder ?? current.sortOrder;
  const now = isoNow();

  await c.env.DB.prepare(
    `UPDATE notebooks
     SET name = ?, slug = ?, parent_id = ?, sort_order = ?, updated_at = ?
     WHERE id = ? AND is_deleted = 0`
  )
    .bind(nextName, slugify(nextName), nextParentId ?? null, nextSortOrder, now, id)
    .run();

  await audit(c.env.DB, actor.actorType, actor.actorId, "notebook.update", "notebook", id, input);
  return c.json({ notebook: await getNotebook(c.env.DB, id) });
});

app.delete("/api/v1/notebooks/:id", async (c) => {
  const denied = requireScopes(c, "write:notebooks");

  if (denied) {
    return denied;
  }

  const id = c.req.param("id");
  const actor = getAuditActor(c);
  const now = isoNow();
  const current = await getNotebook(c.env.DB, id);

  if (!current) {
    return notFound(c, "Notebook not found");
  }

  if (id === "nb_inbox") {
    return badRequest(c, "Inbox cannot be deleted.");
  }

  const [childCount, memoCount] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM notebooks WHERE parent_id = ? AND is_deleted = 0`)
      .bind(id)
      .first<{ count: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM memos WHERE notebook_id = ? AND is_deleted = 0`)
      .bind(id)
      .first<{ count: number }>(),
  ]);

  if ((childCount?.count ?? 0) > 0 || (memoCount?.count ?? 0) > 0) {
    return conflict(c, "notebook_not_empty", "Move or delete child notebooks and memos before deleting this notebook.");
  }

  await c.env.DB.prepare(
    `UPDATE notebooks
     SET is_deleted = 1, deleted_at = ?, updated_at = ?
     WHERE id = ? AND id <> 'nb_inbox'`
  )
    .bind(now, now, id)
    .run();

  await audit(c.env.DB, actor.actorType, actor.actorId, "notebook.delete", "notebook", id, {});
  return c.json({ ok: true });
});

app.get("/api/v1/tags", async (c) => {
  const denied = requireScopes(c, "read:tags");

  if (denied) {
    return denied;
  }

  return c.json({ tags: await listTagSummaries(c.env.DB) });
});

app.patch("/api/v1/tags/:tag", zValidator("json", TagRenameSchema), async (c) => {
  const denied = requireScopes(c, "write:tags");

  if (denied) {
    return denied;
  }

  const oldTag = decodeTagParam(c.req.param("tag"));
  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const updated = await updateTagAcrossMemos(c.env.DB, oldTag, input.name, actor, actorLabel);

  return c.json({ ok: true, updated });
});

app.delete("/api/v1/tags/:tag", async (c) => {
  const denied = requireScopes(c, "write:tags");

  if (denied) {
    return denied;
  }

  const tag = decodeTagParam(c.req.param("tag"));
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const updated = await updateTagAcrossMemos(c.env.DB, tag, null, actor, actorLabel);

  return c.json({ ok: true, updated });
});

app.get("/api/v1/memos", async (c) => {
  const denied = requireScopes(c, "read:memos");

  if (denied) {
    return denied;
  }

  const notebookId = c.req.query("notebookId");
  const q = c.req.query("q")?.trim();
  const includeTrash = c.req.query("trash") === "1";
  const limit = clampNumber(Number(c.req.query("limit") ?? 80), 1, 100);
  const deletedClause = includeTrash ? "m.is_deleted = 1" : "m.is_deleted = 0";

  if (q) {
    const ftsQuery = toFtsQuery(q);
    const likeQuery = `%${escapeLike(q)}%`;

    if (ftsQuery) {
      const rows = await c.env.DB.prepare(
        `WITH raw_matches(memo_id, rank) AS (
           SELECT memo_id, bm25(memos_fts)
           FROM memos_fts
           WHERE memos_fts MATCH ?

           UNION ALL

           SELECT m.id, 100.0
           FROM memos m
           INNER JOIN memo_contents c ON c.memo_id = m.id
           WHERE m.title LIKE ? ESCAPE '\\'
              OR c.content_text LIKE ? ESCAPE '\\'
              OR m.tags_json LIKE ? ESCAPE '\\'
         ),
         search_matches AS (
           SELECT memo_id, MIN(rank) AS rank
           FROM raw_matches
           GROUP BY memo_id
         )
         SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
                m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision
         FROM search_matches s
         INNER JOIN memos m ON m.id = s.memo_id
         INNER JOIN memo_contents c ON c.memo_id = m.id
         WHERE ${deletedClause}
           AND (? IS NULL OR m.notebook_id = ?)
         ORDER BY s.rank ASC, m.is_pinned DESC, m.updated_at DESC
         LIMIT ?`
      )
        .bind(ftsQuery, likeQuery, likeQuery, likeQuery, notebookId ?? null, notebookId ?? null, limit)
        .all<MemoSummaryRow>();

      return c.json({ memos: rows.results.map(mapMemoSummary) });
    }
  }

  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
            m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision
     FROM memos m
     INNER JOIN memo_contents c ON c.memo_id = m.id
     WHERE ${deletedClause}
       AND (? IS NULL OR m.notebook_id = ?)
     ORDER BY ${includeTrash ? "m.deleted_at DESC," : "m.is_pinned DESC,"} m.updated_at DESC
     LIMIT ?`
  )
    .bind(notebookId ?? null, notebookId ?? null, limit)
    .all<MemoSummaryRow>();

  return c.json({ memos: rows.results.map(mapMemoSummary) });
});

app.post("/api/v1/memos", zValidator("json", MemoCreateSchema), async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const tags = normalizeTags(input.tags);
  const contentMarkdown = input.contentMarkdown ?? "";
  const contentJson = markdownToDoc(contentMarkdown);
  const contentText = docToText(contentJson);
  const title = input.title || deriveTitle(contentText);
  const excerpt = createExcerpt(contentText || title || "");
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const id = createId("memo");
  const now = isoNow();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO memos (
        id, notebook_id, title, excerpt, tags_json, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, input.notebookId, title, excerpt, JSON.stringify(tags), actorLabel, actorLabel, now, now),
    c.env.DB.prepare(
      `INSERT INTO memo_contents (
        memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(id, JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, now, now),
    c.env.DB.prepare(
      `INSERT INTO memos_fts (memo_id, title, content_text, tags)
       VALUES (?, ?, ?, ?)`
    ).bind(id, title, contentText, tags.join(" ")),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.create", "memo", id, {
      notebookId: input.notebookId,
    }),
  ]);

  return c.json({ memo: await getMemoDetail(c.env.DB, id) }, 201);
});

app.get("/api/v1/memos/:id", async (c) => {
  const denied = requireScopes(c, "read:memos");

  if (denied) {
    return denied;
  }

  const includeDeleted = c.req.query("includeDeleted") === "1";
  const memo = await getMemoDetail(c.env.DB, c.req.param("id"), includeDeleted);

  if (!memo) {
    return notFound(c, "Memo not found");
  }

  return c.json({ memo });
});

app.get("/api/v1/memos/:id/revisions", async (c) => {
  const denied = requireScopes(c, "read:memos");

  if (denied) {
    return denied;
  }

  const memoId = c.req.param("id");
  const memo = await getMemoDetail(c.env.DB, memoId);

  if (!memo) {
    return notFound(c, "Memo not found");
  }

  const limit = clampNumber(Number(c.req.query("limit") ?? 50), 1, 100);
  const rows = await c.env.DB.prepare(
    `SELECT id, memo_id, revision, title, tags_json, content_json, content_markdown,
            content_text, content_hash, created_by, created_at
     FROM memo_revisions
     WHERE memo_id = ?
     ORDER BY revision DESC, created_at DESC
     LIMIT ?`
  )
    .bind(memoId, limit)
    .all<MemoRevisionRow>();

  return c.json({ revisions: rows.results.map(mapMemoRevision) });
});

app.post("/api/v1/memos/:id/revisions/:revisionId/restore", async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const memoId = c.req.param("id");
  const revisionId = c.req.param("revisionId");
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const current = await getMemoDetailRow(c.env.DB, memoId);

  if (!current) {
    return notFound(c, "Memo not found");
  }

  const revision = await getMemoRevisionRow(c.env.DB, memoId, revisionId);

  if (!revision) {
    return notFound(c, "Memo revision not found");
  }

  const tags = parseJsonArray(revision.tags_json);
  const contentJson = parseDoc(revision.content_json);
  const contentMarkdown = revision.content_markdown || docToMarkdown(contentJson);
  const contentText = revision.content_text || docToText(contentJson);
  const title = revision.title ?? deriveTitle(contentText);
  const excerpt = createExcerpt(contentText || title || "");
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const nextRevision = current.revision + 1;
  const now = isoNow();

  await c.env.DB.batch([
    createMemoRevisionStatement(c.env.DB, current, actorLabel, now),
    c.env.DB.prepare(
      `UPDATE memos
       SET title = ?, excerpt = ?, tags_json = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    ).bind(title, excerpt, JSON.stringify(tags), actorLabel, now, memoId),
    c.env.DB.prepare(
      `UPDATE memo_contents
       SET content_json = ?, content_markdown = ?, content_text = ?, content_hash = ?,
           revision = ?, updated_at = ?
       WHERE memo_id = ?`
    ).bind(JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, nextRevision, now, memoId),
    c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(memoId),
    c.env.DB.prepare(
      `INSERT INTO memos_fts (memo_id, title, content_text, tags)
       VALUES (?, ?, ?, ?)`
    ).bind(memoId, title, contentText, tags.join(" ")),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.revision_restore", "memo", memoId, {
      revisionId,
      restoredRevision: revision.revision,
      revision: nextRevision,
    }),
  ]);

  return c.json({ memo: await getMemoDetail(c.env.DB, memoId) });
});

app.get("/api/v1/resources", async (c) => {
  const denied = requireScopes(c, "read:resources");

  if (denied) {
    return denied;
  }

  const limit = clampNumber(Number(c.req.query("limit") ?? 500), 1, 500);
  const [rows, stats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.memo_id, r.original_memo_id, r.bucket_name, r.object_key, r.kind,
              r.mime_type, r.filename, r.byte_size, r.sha256, r.width, r.height,
              r.created_at, r.updated_at, m.title AS memo_title, m.excerpt AS memo_excerpt,
              m.is_deleted AS memo_is_deleted
       FROM resources r
       LEFT JOIN memos m ON m.id = r.memo_id
       WHERE r.is_deleted = 0
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
      .bind(limit)
      .all<ResourceListRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_count,
              COALESCE(SUM(byte_size), 0) AS total_bytes,
              COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0) AS image_count,
              COALESCE(SUM(CASE WHEN kind = 'attachment' THEN 1 ELSE 0 END), 0) AS attachment_count
       FROM resources
       WHERE is_deleted = 0`
    ).first<ResourceStatsRow>(),
  ]);

  return c.json({
    resources: rows.results.map(mapResourceListItem),
    summary: mapResourceStorageSummary(stats),
  });
});

app.post("/api/v1/memos/:id/resources", async (c) => {
  const denied = requireScopes(c, "write:resources");

  if (denied) {
    return denied;
  }

  const memoId = c.req.param("id");
  const memo = await getMemoDetail(c.env.DB, memoId);

  if (!memo) {
    return notFound(c, "Memo not found");
  }

  const form = await c.req.raw.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return badRequest(c, "Expected multipart form field named file.");
  }

  const mimeType = file.type || "application/octet-stream";

  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return c.json(
      {
        error: {
          code: "unsupported_media_type",
          message: "Only PNG, JPEG, GIF, WebP and AVIF images are supported.",
        },
      },
      415
    );
  }

  if (file.size <= 0 || file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return c.json(
      {
        error: {
          code: "upload_too_large",
          message: "Image must be between 1 byte and 10 MB.",
        },
      },
      413
    );
  }

  const actor = getAuditActor(c);
  const resourceId = createId("res");
  const now = isoNow();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const objectKey = `memos/${memoId}/${resourceId}${inferImageExtension(file.name, mimeType)}`;
  const bucketName = c.env.EDGE_EVER_R2_BUCKET_NAME?.trim() || DEFAULT_R2_BUCKET_NAME;
  const filename = normalizeFilename(file.name) || `${resourceId}${inferImageExtension(file.name, mimeType)}`;
  const checksum = await sha256Bytes(bytes);

  await c.env.RESOURCES.put(objectKey, bytes, {
    httpMetadata: {
      contentType: mimeType,
      cacheControl: "private, max-age=3600",
    },
    customMetadata: {
      memoId,
      resourceId,
      filename,
    },
  });

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO resources (
          id, memo_id, bucket_name, object_key, kind, mime_type, filename,
          byte_size, sha256, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        resourceId,
        memoId,
        bucketName,
        objectKey,
        mimeType,
        filename,
        file.size,
        checksum,
        JSON.stringify({ source: "paste" }),
        now,
        now
      ),
      auditStatement(c.env.DB, actor.actorType, actor.actorId, "resource.create", "resource", resourceId, {
        memoId,
        mimeType,
        byteSize: file.size,
      }),
    ]);
  } catch (error) {
    await c.env.RESOURCES.delete(objectKey);
    throw error;
  }

  const resource = await getResourceRow(c.env.DB, resourceId);

  if (!resource) {
    return notFound(c, "Resource not found");
  }

  return c.json({ resource: mapResource(resource) }, 201);
});

app.get("/api/v1/resources/:id/blob", async (c) => {
  const denied = requireScopes(c, "read:resources");

  if (denied) {
    return denied;
  }

  const resource = await getResourceRow(c.env.DB, c.req.param("id"));

  if (!resource) {
    return notFound(c, "Resource not found");
  }

  const object = await c.env.RESOURCES.get(resource.object_key);

  if (!object) {
    return notFound(c, "Resource object not found");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", resource.mime_type ?? headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Cache-Control", headers.get("Cache-Control") ?? "private, max-age=3600");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", contentDispositionInline(resource.filename));
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(object.body, { headers });
});

app.patch("/api/v1/memos/:id", zValidator("json", MemoUpdateSchema), async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const id = c.req.param("id");
  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const current = await getMemoDetailRow(c.env.DB, id);

  if (!current) {
    return notFound(c, "Memo not found");
  }

  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    return c.json(
      {
        error: {
          code: "revision_conflict",
          message: "Memo was updated elsewhere. Reload before saving.",
          details: {
            expectedRevision: input.expectedRevision,
            currentRevision: current.revision,
          },
        },
      },
      409
    );
  }

  const currentContentJson = JSON.parse(current.content_json) as TiptapDoc;
  const contentJson = input.contentJson
    ? (input.contentJson as TiptapDoc)
    : input.contentMarkdown !== undefined
      ? markdownToDoc(input.contentMarkdown)
      : currentContentJson;
  const contentMarkdown =
    input.contentMarkdown !== undefined ? input.contentMarkdown : docToMarkdown(contentJson);
  const contentText = docToText(contentJson);
  const title = input.title ?? current.title ?? deriveTitle(contentText);
  const tags = input.tags === undefined ? parseJsonArray(current.tags_json) : normalizeTags(input.tags);
  const excerpt = createExcerpt(contentText || title || "");
  const notebookId = input.notebookId ?? current.notebook_id;
  const nextRevision = current.revision + 1;
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const now = isoNow();
  const revisionStatements = (await shouldSnapshotMemoRevision(c.env.DB, current, title, JSON.stringify(tags), contentHash, now))
    ? [createMemoRevisionStatement(c.env.DB, current, actorLabel, now)]
    : [];

  await c.env.DB.batch([
    ...revisionStatements,
    c.env.DB.prepare(
      `UPDATE memos
       SET notebook_id = ?, title = ?, excerpt = ?, tags_json = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    ).bind(notebookId, title, excerpt, JSON.stringify(tags), actorLabel, now, id),
    c.env.DB.prepare(
      `UPDATE memo_contents
       SET content_json = ?, content_markdown = ?, content_text = ?, content_hash = ?,
           revision = ?, updated_at = ?
       WHERE memo_id = ?`
    ).bind(JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, nextRevision, now, id),
    c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(id),
    c.env.DB.prepare(
      `INSERT INTO memos_fts (memo_id, title, content_text, tags)
       VALUES (?, ?, ?, ?)`
    ).bind(id, title, contentText, tags.join(" ")),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.update", "memo", id, {
      revision: nextRevision,
    }),
  ]);

  return c.json({ memo: await getMemoDetail(c.env.DB, id) });
});

app.delete("/api/v1/memos/:id", async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const id = c.req.param("id");
  const actor = getAuditActor(c);
  const permanent = c.req.query("permanent") === "1";
  const now = isoNow();

  if (permanent) {
    const current = await getMemoDetailRow(c.env.DB, id, true);

    if (!current || current.is_deleted === 0) {
      return notFound(c, "Memo not found in trash");
    }

    const resources = await getResourceRowsForMemo(c.env.DB, id);

    if (resources.length > 0) {
      await c.env.RESOURCES.delete(resources.map((resource) => resource.object_key));
    }

    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM resources WHERE memo_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM memo_revisions WHERE memo_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM memo_contents WHERE memo_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM memos WHERE id = ? AND is_deleted = 1`).bind(id),
      auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.delete_permanent", "memo", id, {}),
    ]);

    return c.json({ ok: true });
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE memos
       SET is_deleted = 1, deleted_at = ?, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    ).bind(now, now, id),
    c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(id),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.delete", "memo", id, {}),
  ]);

  return c.json({ ok: true });
});

app.post("/api/v1/memos/:id/restore", async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const id = c.req.param("id");
  const actor = getAuditActor(c);
  const current = await getMemoDetailRow(c.env.DB, id, true);

  if (!current || current.is_deleted === 0) {
    return notFound(c, "Memo not found in trash");
  }

  const tags = parseJsonArray(current.tags_json);
  const now = isoNow();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE memos
       SET is_deleted = 0, deleted_at = NULL, updated_at = ?
       WHERE id = ? AND is_deleted = 1`
    ).bind(now, id),
    c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(id),
    c.env.DB.prepare(
      `INSERT INTO memos_fts (memo_id, title, content_text, tags)
       VALUES (?, ?, ?, ?)`
    ).bind(id, current.title, current.content_text, tags.join(" ")),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.restore", "memo", id, {}),
  ]);

  return c.json({ memo: await getMemoDetail(c.env.DB, id) });
});

app.post("/api/v1/memos/merge", zValidator("json", MergeMemosSchema), async (c) => {
  const denied = requireScopes(c, "write:memos");

  if (denied) {
    return denied;
  }

  const input = c.req.valid("json");
  const actor = getAuditActor(c);
  const actorLabel = getActorLabel(c);
  const uniqueMemoIds = Array.from(new Set(input.memoIds));
  const placeholders = uniqueMemoIds.map(() => "?").join(", ");
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
            m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision,
            c.content_json, c.content_markdown, c.content_text, c.content_hash,
            m.source_memo_ids, m.merge_source_count, m.merged_into_memo_id
     FROM memos m
     INNER JOIN memo_contents c ON c.memo_id = m.id
     WHERE m.is_deleted = 0 AND m.id IN (${placeholders})`
  )
    .bind(...uniqueMemoIds)
    .all<MemoDetailRow>();

  if (rows.results.length !== uniqueMemoIds.length) {
    return c.json(
      {
        error: {
          code: "missing_memos",
          message: "One or more memos cannot be merged.",
        },
      },
      400
    );
  }

  const ordered = uniqueMemoIds
    .map((memoId) => rows.results.find((row) => row.id === memoId))
    .filter((row): row is MemoDetailRow => Boolean(row));
  const notebookId = input.notebookId ?? ordered[0].notebook_id;
  const title = input.title || `合并笔记 ${new Date().toLocaleDateString("zh-CN")}`;
  const mergedMarkdown = ordered.map((memo) => memo.content_markdown).join("\n\n---\n\n");
  const contentJson = markdownToDoc(mergedMarkdown);
  const contentText = docToText(contentJson);
  const tags = Array.from(new Set(ordered.flatMap((memo) => parseJsonArray(memo.tags_json))));
  const excerpt = createExcerpt(contentText || title);
  const contentHash = await sha256(mergedMarkdown + JSON.stringify(contentJson));
  const newMemoId = createId("memo");
  const now = isoNow();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO memos (
        id, notebook_id, title, excerpt, tags_json, source_memo_ids, merge_source_count,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newMemoId,
      notebookId,
      title,
      excerpt,
      JSON.stringify(tags),
      JSON.stringify(uniqueMemoIds),
      uniqueMemoIds.length,
      actorLabel,
      actorLabel,
      now,
      now
    ),
    c.env.DB.prepare(
      `INSERT INTO memo_contents (
        memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(newMemoId, JSON.stringify(contentJson), mergedMarkdown, contentText, contentHash, now, now),
    c.env.DB.prepare(
      `INSERT INTO memos_fts (memo_id, title, content_text, tags)
       VALUES (?, ?, ?, ?)`
    ).bind(newMemoId, title, contentText, tags.join(" ")),
    c.env.DB.prepare(
      `UPDATE memos
       SET is_deleted = 1, deleted_at = ?, merged_into_memo_id = ?, merged_at = ?, updated_at = ?
       WHERE id IN (${placeholders})`
    ).bind(now, newMemoId, now, now, ...uniqueMemoIds),
    c.env.DB.prepare(`DELETE FROM memos_fts WHERE memo_id IN (${placeholders})`).bind(...uniqueMemoIds),
    c.env.DB.prepare(
      `UPDATE resources
       SET original_memo_id = COALESCE(original_memo_id, memo_id),
           memo_id = ?,
           updated_at = ?
       WHERE memo_id IN (${placeholders})`
    ).bind(newMemoId, now, ...uniqueMemoIds),
    auditStatement(c.env.DB, actor.actorType, actor.actorId, "memo.merge", "memo", newMemoId, {
      sourceMemoIds: uniqueMemoIds,
    }),
  ]);

  return c.json({ memo: await getMemoDetail(c.env.DB, newMemoId) }, 201);
});

app.get("/mcp", (c) =>
  c.json({
    name: "EdgeEver MCP endpoint",
    status: "ready",
    transport: "streamable-http-jsonrpc",
    auth: "Authorization: Bearer <api-token>",
    restBasePath: "/api/v1",
  })
);

app.post("/mcp", async (c) => {
  let request: JsonRpcRequest;

  try {
    request = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return c.json(jsonRpcError(getJsonRpcId(request), -32600, "Invalid Request"), 400);
  }

  if (request.method === "notifications/initialized" && request.id === undefined) {
    return new Response(null, { status: 204 });
  }

  if (request.method === "initialize") {
    return c.json(
      jsonRpcResult(request.id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "edgeever",
          version: "0.1.0",
        },
      })
    );
  }

  const auth = await authenticateRequest(c, true);

  if (!auth) {
    return c.json(jsonRpcError(request.id ?? null, -32001, "Authentication required"), 401);
  }

  c.set("auth", auth);

  if (request.method === "tools/list") {
    return c.json(
      jsonRpcResult(request.id ?? null, {
        tools: MCP_TOOLS,
      })
    );
  }

  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = typeof params.name === "string" ? params.name : "";
    const args = asRecord(params.arguments);

    try {
      const result = await callMcpTool(c, auth, name, args);
      return c.json(
        jsonRpcResult(request.id ?? null, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed";
      return c.json(jsonRpcError(request.id ?? null, -32000, message), 400);
    }
  }

  return c.json(jsonRpcError(request.id ?? null, -32601, "Method not found"), 404);
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    },
    404
  )
);

export default app;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type JsonRpcId = string | number | null;

const MCP_TOOLS = [
  {
    name: "search_memos",
    description: "Search active EdgeEver memos by text, tag, or notebook.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        notebookId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "get_memo",
    description: "Read a memo with Markdown content.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      properties: {
        memoId: { type: "string" },
      },
    },
  },
  {
    name: "create_memo",
    description: "Create a memo in a notebook.",
    inputSchema: {
      type: "object",
      required: ["notebookId"],
      properties: {
        notebookId: { type: "string" },
        title: { type: "string" },
        contentMarkdown: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "update_memo",
    description: "Update memo title, Markdown, tags, or notebook.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      properties: {
        memoId: { type: "string" },
        title: { type: "string" },
        contentMarkdown: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        notebookId: { type: "string" },
        expectedRevision: { type: "number" },
      },
    },
  },
  {
    name: "list_notebooks",
    description: "List active notebooks.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_tags",
    description: "List tags and memo counts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const callMcpTool = async (
  c: AppContext,
  auth: AuthContext,
  name: string,
  args: Record<string, unknown>
) => {
  switch (name) {
    case "search_memos": {
      assertScope(auth, "read:memos");
      return {
        memos: await searchMemoSummaries(c.env.DB, {
          query: getOptionalString(args.query),
          notebookId: getOptionalString(args.notebookId),
          limit: clampNumber(Number(args.limit ?? 20), 1, 50),
        }),
      };
    }
    case "get_memo": {
      assertScope(auth, "read:memos");
      const memoId = getRequiredString(args.memoId, "memoId");
      const memo = await getMemoDetail(c.env.DB, memoId);

      if (!memo) {
        throw new Error("Memo not found");
      }

      return { memo };
    }
    case "create_memo": {
      assertScope(auth, "write:memos");
      const notebookId = getRequiredString(args.notebookId, "notebookId");
      const actor = getAuditActor(c);
      const actorLabel = getActorLabel(c);
      const memo = await createMemoRecord(c.env.DB, {
        notebookId,
        title: getOptionalString(args.title) ?? undefined,
        contentMarkdown: getOptionalString(args.contentMarkdown) ?? "",
        tags: getOptionalStringArray(args.tags),
      }, actor, actorLabel);

      return { memo };
    }
    case "update_memo": {
      assertScope(auth, "write:memos");
      const memoId = getRequiredString(args.memoId, "memoId");
      const actor = getAuditActor(c);
      const actorLabel = getActorLabel(c);
      const result = await updateMemoRecord(
        c.env.DB,
        memoId,
        {
          expectedRevision:
            typeof args.expectedRevision === "number" && Number.isInteger(args.expectedRevision)
              ? args.expectedRevision
              : undefined,
          notebookId: getOptionalString(args.notebookId) ?? undefined,
          title: getOptionalString(args.title) ?? undefined,
          contentMarkdown: getOptionalString(args.contentMarkdown) ?? undefined,
          tags: Array.isArray(args.tags) ? getOptionalStringArray(args.tags) : undefined,
        },
        actor,
        actorLabel
      );

      if ("error" in result) {
        throw new Error(result.message);
      }

      return { memo: result.memo };
    }
    case "list_notebooks": {
      assertScope(auth, "read:notebooks");
      return { notebooks: await listNotebooks(c.env.DB) };
    }
    case "list_tags": {
      assertScope(auth, "read:tags");
      return { tags: await listTagSummaries(c.env.DB) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

const jsonRpcResult = (id: JsonRpcId, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
});

const jsonRpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  },
});

const getJsonRpcId = (request: unknown): JsonRpcId => {
  if (!request || typeof request !== "object" || !("id" in request)) {
    return null;
  }

  const id = (request as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const getOptionalString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const getRequiredString = (value: unknown, name: string) => {
  const parsed = getOptionalString(value);

  if (!parsed) {
    throw new Error(`${name} is required`);
  }

  return parsed;
};

const getOptionalStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const isAuthRequired = async (env: Bindings) => {
  if (env.EDGE_EVER_AUTH_PASSWORD_HASH?.trim()) {
    return true;
  }

  const user = await env.DB.prepare(`SELECT id FROM users WHERE is_disabled = 0 LIMIT 1`).first<{ id: string }>();
  return Boolean(user);
};

const verifyLogin = async (env: Bindings, username: string, password: string): Promise<UserRow | null> => {
  const normalizedUsername = username.trim();
  const existingUser = await getUserByUsername(env.DB, normalizedUsername);

  if (existingUser) {
    return (await verifyPassword(password, existingUser.password_hash)) ? existingUser : null;
  }

  const configuredHash = env.EDGE_EVER_AUTH_PASSWORD_HASH?.trim();

  if (!configuredHash) {
    return null;
  }

  const configuredUsername = env.EDGE_EVER_AUTH_USERNAME?.trim() || "admin";

  if (normalizedUsername !== configuredUsername || !(await verifyPassword(password, configuredHash))) {
    return null;
  }

  const now = isoNow();
  const userId = createId("usr");
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, normalizedUsername, passwordHash, normalizedUsername, now, now)
    .run();

  return getUserByUsername(env.DB, normalizedUsername);
};

const getUserByUsername = async (db: D1Database, username: string) =>
  db
    .prepare(
      `SELECT id, username, password_hash, display_name, is_disabled
       FROM users
       WHERE username = ? AND is_disabled = 0`
    )
    .bind(username)
    .first<UserRow>();

const createSession = async (c: AppContext, user: UserRow) => {
  const token = randomToken(SESSION_TOKEN_BYTES);
  const id = createId("sess");
  const now = isoNow();
  const maxAge = getSessionMaxAge(c.env);
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  const ip = c.req.header("CF-Connecting-IP");
  const ipHash = ip ? await sha256(ip) : null;

  await c.env.DB.prepare(
    `INSERT INTO sessions (
      id, user_id, token_hash, user_agent, ip_hash, expires_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      await sha256(token),
      c.req.header("User-Agent") ?? null,
      ipHash,
      expiresAt,
      now,
      now
    )
    .run();

  return { id, token, maxAge };
};

const setSessionCookie = (c: AppContext, token: string, maxAge: number) => {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
};

const revokeSession = async (db: D1Database, token: string) => {
  await db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .bind(isoNow(), await sha256(token))
    .run();
};

const authenticateRequest = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const bearerAuth = await authenticateBearerToken(c, touch);

  if (bearerAuth) {
    return bearerAuth;
  }

  return authenticateSession(c, touch);
};

const authenticateBearerToken = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const token = getBearerToken(c);

  if (!token) {
    return null;
  }

  const row = await c.env.DB.prepare(
    `SELECT id, name, scopes_json, last_used_at, expires_at, is_revoked, created_at
     FROM api_tokens
     WHERE token_hash = ?
       AND is_revoked = 0
       AND (expires_at IS NULL OR expires_at > ?)`
  )
    .bind(await sha256(token), isoNow())
    .first<ApiTokenRow>();

  if (!row) {
    return null;
  }

  if (touch) {
    await c.env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).bind(isoNow(), row.id).run();
  }

  return {
    kind: "agent",
    actorType: "agent",
    actorId: row.id,
    username: row.name,
    displayName: row.name,
    scopes: parseJsonArray(row.scopes_json),
    tokenId: row.id,
  };
};

const authenticateSession = async (c: AppContext, touch: boolean): Promise<AuthContext | null> => {
  const token = getCookie(c, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, u.username, u.display_name, s.expires_at
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
       AND u.is_disabled = 0`
  )
    .bind(await sha256(token), isoNow())
    .first<SessionRow>();

  if (!row) {
    return null;
  }

  if (touch) {
    await c.env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(isoNow(), row.id).run();
  }

  return {
    kind: "user",
    actorType: "user",
    actorId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    scopes: [],
    sessionId: row.id,
  };
};

const getBearerToken = (c: AppContext) => {
  const authorization = c.req.header("Authorization");

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token ? token : null;
};

const getAuditActor = (c: AppContext) => {
  const auth = c.get("auth");

  return {
    actorType: auth?.actorType ?? "user",
    actorId: auth?.actorId ?? null,
  };
};

const getActorLabel = (c: AppContext) => {
  const auth = c.get("auth");
  return auth?.actorId ? `${auth.actorType}:${auth.actorId}` : auth?.username ?? "user";
};

const requireUser = (c: AppContext) => {
  const auth = c.get("auth");

  if (auth?.kind === "user") {
    return null;
  }

  return forbidden(c, "Only an interactive user session can manage this resource.");
};

const requireScopes = (c: AppContext, ...scopes: TokenScope[]) => {
  const auth = c.get("auth");

  if (!auth) {
    return unauthorized(c, "Authentication required.");
  }

  if (hasScopes(auth, scopes)) {
    return null;
  }

  return forbidden(c, `Missing required scope: ${scopes.join(", ")}`);
};

const assertScope = (auth: AuthContext, scope: TokenScope) => {
  if (!hasScopes(auth, [scope])) {
    throw new Error(`Missing required scope: ${scope}`);
  }
};

const hasScopes = (auth: AuthContext, scopes: TokenScope[]) => {
  if (auth.kind === "user") {
    return true;
  }

  return scopes.every((scope) => auth.scopes.includes(scope));
};

const normalizeTokenScopes = (scopes: string[]) => {
  const normalized = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));

  if (normalized.some((scope) => !isTokenScope(scope))) {
    return null;
  }

  return normalized as TokenScope[];
};

const isTokenScope = (scope: string): scope is TokenScope =>
  (ALL_TOKEN_SCOPES as readonly string[]).includes(scope);

const getSessionMaxAge = (env: Bindings) => {
  const days = clampNumber(Number(env.EDGE_EVER_SESSION_TTL_DAYS ?? DEFAULT_SESSION_TTL_DAYS), 1, 90);
  return days * 24 * 60 * 60;
};

const hashPassword = async (password: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);

  return [
    PASSWORD_HASH_ALGORITHM,
    PASSWORD_HASH_ITERATIONS,
    base64UrlEncode(salt),
    base64UrlEncode(hash),
  ].join("$");
};

const verifyPassword = async (password: string, passwordHash: string) => {
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = passwordHash.split("$");
  const iterations = Number(iterationsRaw);

  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    !saltRaw ||
    !hashRaw
  ) {
    return false;
  }

  try {
    const expected = base64UrlDecode(hashRaw);
    const salt = base64UrlDecode(saltRaw);
    const actual = await derivePasswordHash(password, salt, iterations);

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

const derivePasswordHash = async (password: string, salt: Uint8Array, iterations: number) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBuffer,
      iterations,
    },
    key,
    PASSWORD_HASH_BYTES * 8
  );

  return new Uint8Array(bits);
};

const randomToken = (bytes: number) => {
  const token = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(token);
};

const base64UrlEncode = (bytes: Uint8Array) => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlDecode = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const timingSafeEqual = (left: Uint8Array, right: Uint8Array) => {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  }

  return diff === 0;
};

const mapNotebook = (row: NotebookRow): Notebook => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  slug: row.slug,
  icon: row.icon,
  color: row.color,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapMemoSummary = (row: MemoSummaryRow): MemoSummary => ({
  id: row.id,
  notebookId: row.notebook_id,
  title: row.title,
  excerpt: row.excerpt,
  tags: parseJsonArray(row.tags_json),
  isPinned: Boolean(row.is_pinned),
  isArchived: Boolean(row.is_archived),
  isDeleted: Boolean(row.is_deleted),
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const mapMemoDetail = (row: MemoDetailRow): MemoDetail => ({
  ...mapMemoSummary(row),
  contentJson: parseDoc(row.content_json),
  contentMarkdown: row.content_markdown,
  contentText: row.content_text,
  sourceMemoIds: parseJsonArray(row.source_memo_ids),
  mergeSourceCount: row.merge_source_count,
  mergedIntoMemoId: row.merged_into_memo_id,
});

const mapMemoRevision = (row: MemoRevisionRow): MemoRevision => ({
  id: row.id,
  memoId: row.memo_id,
  revision: row.revision,
  title: row.title,
  tags: parseJsonArray(row.tags_json),
  contentMarkdown: row.content_markdown,
  contentText: row.content_text,
  contentHash: row.content_hash,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const mapResource = (row: ResourceRow): Resource => ({
  id: row.id,
  memoId: row.memo_id,
  originalMemoId: row.original_memo_id,
  kind: row.kind,
  mimeType: row.mime_type,
  filename: row.filename,
  byteSize: row.byte_size,
  sha256: row.sha256,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  url: `/api/v1/resources/${row.id}/blob`,
});

const mapResourceListItem = (row: ResourceListRow): ResourceListItem => ({
  ...mapResource(row),
  memoTitle: row.memo_title,
  memoExcerpt: row.memo_excerpt,
  memoDeleted: Boolean(row.memo_is_deleted),
});

const mapResourceStorageSummary = (row: ResourceStatsRow | null): ResourceStorageSummary => ({
  totalCount: row?.total_count ?? 0,
  totalBytes: row?.total_bytes ?? 0,
  imageCount: row?.image_count ?? 0,
  attachmentCount: row?.attachment_count ?? 0,
});

const mapApiToken = (row: ApiTokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  scopes: parseJsonArray(row.scopes_json),
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  isRevoked: Boolean(row.is_revoked),
  createdAt: row.created_at,
});

const mapTagSummary = (row: TagSummaryRow): TagSummary => ({
  name: row.name,
  memoCount: row.memo_count,
  updatedAt: row.updated_at,
});

const getApiTokenRow = async (db: D1Database, id: string): Promise<ApiTokenRow | null> =>
  db
    .prepare(
      `SELECT id, name, scopes_json, last_used_at, expires_at, is_revoked, created_at
       FROM api_tokens
       WHERE id = ?`
    )
    .bind(id)
    .first<ApiTokenRow>();

const listNotebooks = async (db: D1Database): Promise<Notebook[]> => {
  const rows = await db
    .prepare(
      `SELECT id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at
       FROM notebooks
       WHERE is_deleted = 0
       ORDER BY parent_id IS NOT NULL, sort_order ASC, name ASC`
    )
    .all<NotebookRow>();

  return rows.results.map(mapNotebook);
};

const listTagSummaries = async (db: D1Database): Promise<TagSummary[]> => {
  const rows = await db
    .prepare(
      `SELECT json_each.value AS name,
              COUNT(DISTINCT m.id) AS memo_count,
              MAX(m.updated_at) AS updated_at
       FROM memos m, json_each(m.tags_json)
       WHERE m.is_deleted = 0
         AND trim(json_each.value) <> ''
       GROUP BY json_each.value
       ORDER BY lower(json_each.value) ASC`
    )
    .all<TagSummaryRow>();

  return rows.results
    .filter((row) => typeof row.name === "string" && row.name.trim())
    .map(mapTagSummary);
};

const updateTagAcrossMemos = async (
  db: D1Database,
  oldTag: string,
  nextTag: string | null,
  actor: { actorType: "user" | "agent"; actorId: string | null },
  actorLabel: string
) => {
  const normalizedOld = normalizeTags([oldTag])[0];
  const normalizedNext = nextTag === null ? null : normalizeTags([nextTag])[0];

  if (!normalizedOld || normalizedOld === normalizedNext) {
    return 0;
  }

  const rows = await db
    .prepare(
      `SELECT m.id, m.title, m.tags_json, c.content_text
       FROM memos m
       INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.is_deleted = 0
         AND EXISTS (
           SELECT 1
           FROM json_each(m.tags_json)
           WHERE json_each.value = ?
         )`
    )
    .bind(normalizedOld)
    .all<MemoTagUpdateRow>();

  const now = isoNow();
  const statements: D1PreparedStatement[] = [];
  let updated = 0;

  for (const row of rows.results) {
    const currentTags = parseJsonArray(row.tags_json);

    if (!currentTags.includes(normalizedOld)) {
      continue;
    }

    const nextTags = normalizeTags(
      currentTags.flatMap((tag) => {
        if (tag !== normalizedOld) {
          return [tag];
        }

        return normalizedNext ? [normalizedNext] : [];
      })
    );

    statements.push(
      db
        .prepare(
          `UPDATE memos
           SET tags_json = ?, updated_by = ?, updated_at = ?
           WHERE id = ? AND is_deleted = 0`
        )
        .bind(JSON.stringify(nextTags), actorLabel, now, row.id),
      db.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(row.id),
      db
        .prepare(
          `INSERT INTO memos_fts (memo_id, title, content_text, tags)
           VALUES (?, ?, ?, ?)`
        )
        .bind(row.id, row.title, row.content_text, nextTags.join(" ")),
      auditStatement(db, actor.actorType, actor.actorId, normalizedNext ? "tag.rename" : "tag.delete", "memo", row.id, {
        from: normalizedOld,
        to: normalizedNext,
      })
    );
    updated += 1;
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return updated;
};

const searchMemoSummaries = async (
  db: D1Database,
  options: { query?: string | null; notebookId?: string | null; limit: number }
): Promise<MemoSummary[]> => {
  const q = options.query?.trim();
  const notebookId = options.notebookId?.trim() || null;
  const limit = clampNumber(options.limit, 1, 100);

  if (q) {
    const ftsQuery = toFtsQuery(q);
    const likeQuery = `%${escapeLike(q)}%`;

    if (ftsQuery) {
      const rows = await db
        .prepare(
          `WITH raw_matches(memo_id, rank) AS (
             SELECT memo_id, bm25(memos_fts)
             FROM memos_fts
             WHERE memos_fts MATCH ?

             UNION ALL

             SELECT m.id, 100.0
             FROM memos m
             INNER JOIN memo_contents c ON c.memo_id = m.id
             WHERE m.title LIKE ? ESCAPE '\\'
                OR c.content_text LIKE ? ESCAPE '\\'
                OR m.tags_json LIKE ? ESCAPE '\\'
           ),
           search_matches AS (
             SELECT memo_id, MIN(rank) AS rank
             FROM raw_matches
             GROUP BY memo_id
           )
           SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
                  m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision
           FROM search_matches s
           INNER JOIN memos m ON m.id = s.memo_id
           INNER JOIN memo_contents c ON c.memo_id = m.id
           WHERE m.is_deleted = 0
             AND (? IS NULL OR m.notebook_id = ?)
           ORDER BY s.rank ASC, m.is_pinned DESC, m.updated_at DESC
           LIMIT ?`
        )
        .bind(ftsQuery, likeQuery, likeQuery, likeQuery, notebookId, notebookId, limit)
        .all<MemoSummaryRow>();

      return rows.results.map(mapMemoSummary);
    }
  }

  const rows = await db
    .prepare(
      `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
              m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision
       FROM memos m
       INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.is_deleted = 0
         AND (? IS NULL OR m.notebook_id = ?)
       ORDER BY m.is_pinned DESC, m.updated_at DESC
       LIMIT ?`
    )
    .bind(notebookId, notebookId, limit)
    .all<MemoSummaryRow>();

  return rows.results.map(mapMemoSummary);
};

const getNotebook = async (db: D1Database, id: string): Promise<Notebook | null> => {
  const row = await db
    .prepare(
      `SELECT id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at
       FROM notebooks
       WHERE id = ? AND is_deleted = 0`
    )
    .bind(id)
    .first<NotebookRow>();

  return row ? mapNotebook(row) : null;
};

const getMemoDetailRow = async (
  db: D1Database,
  id: string,
  includeDeleted = false
): Promise<MemoDetailRow | null> =>
  db
    .prepare(
      `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
              m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision,
              c.content_json, c.content_markdown, c.content_text, c.content_hash,
              m.source_memo_ids, m.merge_source_count, m.merged_into_memo_id
       FROM memos m
       INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.id = ? AND (? = 1 OR m.is_deleted = 0)`
    )
    .bind(id, includeDeleted ? 1 : 0)
    .first<MemoDetailRow>();

const getMemoDetail = async (db: D1Database, id: string, includeDeleted = false): Promise<MemoDetail | null> => {
  const row = await getMemoDetailRow(db, id, includeDeleted);
  return row ? mapMemoDetail(row) : null;
};

const createMemoRecord = async (
  db: D1Database,
  input: { notebookId: string; title?: string; contentMarkdown?: string; tags?: string[] },
  actor: { actorType: "user" | "agent"; actorId: string | null },
  actorLabel: string
): Promise<MemoDetail> => {
  const tags = normalizeTags(input.tags);
  const contentMarkdown = input.contentMarkdown ?? "";
  const contentJson = markdownToDoc(contentMarkdown);
  const contentText = docToText(contentJson);
  const title = input.title || deriveTitle(contentText);
  const excerpt = createExcerpt(contentText || title || "");
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const id = createId("memo");
  const now = isoNow();

  await db.batch([
    db
      .prepare(
        `INSERT INTO memos (
          id, notebook_id, title, excerpt, tags_json, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.notebookId, title, excerpt, JSON.stringify(tags), actorLabel, actorLabel, now, now),
    db
      .prepare(
        `INSERT INTO memo_contents (
          memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(id, JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, now, now),
    db
      .prepare(
        `INSERT INTO memos_fts (memo_id, title, content_text, tags)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, title, contentText, tags.join(" ")),
    auditStatement(db, actor.actorType, actor.actorId, "memo.create", "memo", id, {
      notebookId: input.notebookId,
    }),
  ]);

  const memo = await getMemoDetail(db, id);

  if (!memo) {
    throw new Error("Memo was created but could not be read.");
  }

  return memo;
};

const updateMemoRecord = async (
  db: D1Database,
  id: string,
  input: {
    expectedRevision?: number;
    notebookId?: string;
    title?: string;
    contentMarkdown?: string;
    tags?: string[];
  },
  actor: { actorType: "user" | "agent"; actorId: string | null },
  actorLabel: string
): Promise<{ memo: MemoDetail; error?: never; message?: never } | { error: string; message: string }> => {
  const current = await getMemoDetailRow(db, id);

  if (!current) {
    return { error: "not_found", message: "Memo not found" };
  }

  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    return { error: "revision_conflict", message: "Memo was updated elsewhere. Reload before saving." };
  }

  const currentContentJson = parseDoc(current.content_json);
  const contentJson = input.contentMarkdown !== undefined ? markdownToDoc(input.contentMarkdown) : currentContentJson;
  const contentMarkdown =
    input.contentMarkdown !== undefined ? input.contentMarkdown : docToMarkdown(contentJson);
  const contentText = docToText(contentJson);
  const title = input.title ?? current.title ?? deriveTitle(contentText);
  const tags = input.tags === undefined ? parseJsonArray(current.tags_json) : normalizeTags(input.tags);
  const excerpt = createExcerpt(contentText || title || "");
  const notebookId = input.notebookId ?? current.notebook_id;
  const nextRevision = current.revision + 1;
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const now = isoNow();
  const revisionStatements = (await shouldSnapshotMemoRevision(db, current, title, JSON.stringify(tags), contentHash, now))
    ? [createMemoRevisionStatement(db, current, actorLabel, now)]
    : [];

  await db.batch([
    ...revisionStatements,
    db
      .prepare(
        `UPDATE memos
         SET notebook_id = ?, title = ?, excerpt = ?, tags_json = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND is_deleted = 0`
      )
      .bind(notebookId, title, excerpt, JSON.stringify(tags), actorLabel, now, id),
    db
      .prepare(
        `UPDATE memo_contents
         SET content_json = ?, content_markdown = ?, content_text = ?, content_hash = ?,
             revision = ?, updated_at = ?
         WHERE memo_id = ?`
      )
      .bind(JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, nextRevision, now, id),
    db.prepare(`DELETE FROM memos_fts WHERE memo_id = ?`).bind(id),
    db
      .prepare(
        `INSERT INTO memos_fts (memo_id, title, content_text, tags)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, title, contentText, tags.join(" ")),
    auditStatement(db, actor.actorType, actor.actorId, "memo.update", "memo", id, {
      revision: nextRevision,
    }),
  ]);

  const memo = await getMemoDetail(db, id);

  if (!memo) {
    return { error: "not_found", message: "Memo not found after update" };
  }

  return { memo };
};

const getMemoRevisionRow = async (
  db: D1Database,
  memoId: string,
  revisionId: string
): Promise<MemoRevisionRow | null> =>
  db
    .prepare(
      `SELECT id, memo_id, revision, title, tags_json, content_json, content_markdown,
              content_text, content_hash, created_by, created_at
       FROM memo_revisions
       WHERE id = ? AND memo_id = ?`
    )
    .bind(revisionId, memoId)
    .first<MemoRevisionRow>();

const getLatestMemoRevisionRow = async (db: D1Database, memoId: string): Promise<MemoRevisionRow | null> =>
  db
    .prepare(
      `SELECT id, memo_id, revision, title, tags_json, content_json, content_markdown,
              content_text, content_hash, created_by, created_at
       FROM memo_revisions
       WHERE memo_id = ?
       ORDER BY created_at DESC, revision DESC
       LIMIT 1`
    )
    .bind(memoId)
    .first<MemoRevisionRow>();

const createMemoRevisionStatement = (
  db: D1Database,
  current: MemoDetailRow,
  actorLabel: string,
  createdAt: string
) =>
  db
    .prepare(
      `INSERT INTO memo_revisions (
        id, memo_id, revision, title, content_json, content_markdown,
        content_hash, created_by, created_at, tags_json, content_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      createId("rev"),
      current.id,
      current.revision,
      current.title,
      current.content_json,
      current.content_markdown,
      current.content_hash,
      actorLabel,
      createdAt,
      current.tags_json,
      current.content_text
    );

const shouldSnapshotMemoRevision = async (
  db: D1Database,
  current: MemoDetailRow,
  nextTitle: string | null,
  nextTagsJson: string,
  nextContentHash: string,
  now: string
) => {
  const changed =
    (current.title ?? "") !== (nextTitle ?? "") ||
    current.tags_json !== nextTagsJson ||
    current.content_hash !== nextContentHash;

  if (!changed) {
    return false;
  }

  const latest = await getLatestMemoRevisionRow(db, current.id);

  if (!latest) {
    return true;
  }

  const alreadyCapturedCurrent =
    (latest.title ?? "") === (current.title ?? "") &&
    latest.tags_json === current.tags_json &&
    latest.content_hash === current.content_hash;

  if (alreadyCapturedCurrent) {
    return false;
  }

  return Date.parse(now) - Date.parse(latest.created_at) >= REVISION_SNAPSHOT_INTERVAL_MS;
};

const getResourceRow = async (db: D1Database, id: string): Promise<ResourceRow | null> =>
  db
    .prepare(
      `SELECT id, memo_id, original_memo_id, bucket_name, object_key, kind, mime_type,
              filename, byte_size, sha256, width, height, created_at, updated_at
       FROM resources
       WHERE id = ? AND is_deleted = 0`
    )
    .bind(id)
    .first<ResourceRow>();

const getResourceRowsForMemo = async (db: D1Database, memoId: string): Promise<ResourceRow[]> => {
  const rows = await db
    .prepare(
      `SELECT id, memo_id, original_memo_id, bucket_name, object_key, kind, mime_type,
              filename, byte_size, sha256, width, height, created_at, updated_at
       FROM resources
       WHERE memo_id = ?`
    )
    .bind(memoId)
    .all<ResourceRow>();

  return rows.results;
};

const parseJsonArray = (json: string): string[] => {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const parseDoc = (json: string): TiptapDoc => {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as TiptapDoc) : emptyDoc();
  } catch {
    return emptyDoc();
  }
};

const audit = async (
  db: D1Database,
  actorType: "user" | "agent" | "system",
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata: unknown
) => auditStatement(db, actorType, actorId, action, entityType, entityId, metadata).run();

const auditStatement = (
  db: D1Database,
  actorType: "user" | "agent" | "system",
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata: unknown
) =>
  db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(createId("audit"), actorType, actorId, action, entityType, entityId, JSON.stringify(metadata ?? {}), isoNow());

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

const isoNow = () => new Date().toISOString();

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const deriveTitle = (text: string) => {
  const title = text.trim().split(/\s+/).slice(0, 10).join(" ");
  return title || "Untitled memo";
};

const clampNumber = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
};

const toFtsQuery = (value: string) => {
  const tokens = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens
    .slice(0, 8)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return sha256Bytes(bytes);
};

const sha256Bytes = async (bytes: Uint8Array) => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const inferImageExtension = (filename: string, mimeType: string) => {
  const extension = /\.(png|jpe?g|gif|webp|avif)$/i.exec(filename)?.[0]?.toLowerCase();

  if (extension) {
    return extension === ".jpeg" ? ".jpg" : extension;
  }

  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    default:
      return "";
  }
};

const normalizeFilename = (filename: string) =>
  filename
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 160);

const contentDispositionInline = (filename: string | null) => {
  if (!filename) {
    return "inline";
  }

  const fallback = normalizeFilename(filename).replace(/"/g, "'");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

const decodeTagParam = (value: string) => {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
};

const notFound = (c: Context, message: string) =>
  c.json(
    {
      error: {
        code: "not_found",
        message,
      },
    },
    404
  );

const badRequest = (c: Context, message: string) =>
  c.json(
    {
      error: {
        code: "bad_request",
        message,
      },
    },
    400
  );

const conflict = (c: Context, code: string, message: string) =>
  c.json(
    {
      error: {
        code,
        message,
      },
    },
    409
  );

const unauthorized = (c: Context, message: string) =>
  c.json(
    {
      error: {
        code: "unauthorized",
        message,
      },
    },
    401
  );

const forbidden = (c: Context, message: string) =>
  c.json(
    {
      error: {
        code: "forbidden",
        message,
      },
    },
    403
  );
