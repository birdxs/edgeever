import AsyncStorage from "@react-native-async-storage/async-storage";
import { ApiRequestError, type createEdgeEverClient } from "@edgeever/client";
import type { MemoDetail } from "@edgeever/shared";

const SYNC_QUEUE_KEY = "edgeever.mobile.syncQueue.v1";

export type MobileMemoUpdateSyncPayload = {
  memoId: string;
  expectedRevision: number;
  expectedContentHash: string;
  title: string;
  contentMarkdown: string;
  notebookId: string;
  tags: string[];
};

export type MobileSyncQueueItem = {
  id: string;
  kind: "memo.update";
  memoId: string;
  status: "pending" | "syncing" | "conflict" | "error";
  payload: MobileMemoUpdateSyncPayload;
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileSyncQueueSummary = {
  total: number;
  pending: number;
  syncing: number;
  conflict: number;
  error: number;
};

export type MobileSyncRunResult = {
  attempted: number;
  synced: number;
  failed: number;
  conflicted: number;
};

export const emptyMobileSyncQueueSummary = (): MobileSyncQueueSummary => ({
  total: 0,
  pending: 0,
  syncing: 0,
  conflict: 0,
  error: 0,
});

export const getMobileMemoUpdateQueueId = (memoId: string) => `memo.update:${memoId}`;

export const queueMobileMemoUpdate = async (payload: MobileMemoUpdateSyncPayload) => {
  const now = new Date().toISOString();
  const items = await readMobileSyncQueue();
  const id = getMobileMemoUpdateQueueId(payload.memoId);
  const existing = items.find((item) => item.id === id);
  const nextItem: MobileSyncQueueItem = {
    id,
    kind: "memo.update",
    memoId: payload.memoId,
    status: "pending",
    payload,
    attemptCount: existing?.attemptCount ?? 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await writeMobileSyncQueue([nextItem, ...items.filter((item) => item.id !== id)]);
  return summarizeMobileSyncQueue(await readMobileSyncQueue());
};

export const loadMobileSyncQueueSummary = async () => summarizeMobileSyncQueue(await readMobileSyncQueue());

export const listMobileSyncQueueItems = async () =>
  (await readMobileSyncQueue()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const deleteMobileSyncQueueItem = async (id: string) => {
  await removeMobileSyncQueueItem(id);
  return loadMobileSyncQueueSummary();
};

export const syncMobileQueuedChanges = async (
  client: ReturnType<typeof createEdgeEverClient>,
  options: {
    onSynced?: (memo: MemoDetail) => void | Promise<void>;
  } = {}
): Promise<MobileSyncRunResult> => {
  const result: MobileSyncRunResult = {
    attempted: 0,
    synced: 0,
    failed: 0,
    conflicted: 0,
  };
  const now = new Date();
  const items = (await readMobileSyncQueue())
    .filter((item) => item.status === "pending" || item.status === "error" || item.status === "syncing")
    .filter((item) => !item.nextAttemptAt || new Date(item.nextAttemptAt) <= now)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const item of items) {
    result.attempted += 1;
    await updateMobileSyncQueueItem(item.id, {
      status: "syncing",
      updatedAt: new Date().toISOString(),
    });

    try {
      const memo = await syncMobileQueueItem(client, item);
      await removeMobileSyncQueueItem(item.id);
      await options.onSynced?.(memo);
      result.synced += 1;
    } catch (error) {
      const status = isRevisionConflict(error) ? "conflict" : "error";
      const attemptCount = item.attemptCount + 1;

      await updateMobileSyncQueueItem(item.id, {
        status,
        attemptCount,
        lastError: getErrorMessage(error),
        nextAttemptAt: status === "error" ? nextRetryAt(attemptCount) : null,
        updatedAt: new Date().toISOString(),
      });

      if (status === "conflict") {
        result.conflicted += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
};

export const shouldQueueMobileMemoSaveError = (error: unknown) => {
  if (error instanceof ApiRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return error instanceof TypeError || getErrorMessage(error).toLowerCase().includes("network");
};

const syncMobileQueueItem = async (client: ReturnType<typeof createEdgeEverClient>, item: MobileSyncQueueItem) => {
  const { editSession } = await client.createMemoEditSession(item.memoId);

  if (
    editSession.baseRevision !== item.payload.expectedRevision ||
    editSession.baseContentHash !== item.payload.expectedContentHash
  ) {
    throw new ApiRequestError("Note changed before the offline draft could sync.", 409, "revision_conflict");
  }

  const response = await client.updateMemo(item.memoId, {
    expectedRevision: item.payload.expectedRevision,
    expectedContentHash: item.payload.expectedContentHash,
    editSessionId: editSession.id,
    title: item.payload.title,
    contentMarkdown: item.payload.contentMarkdown,
    notebookId: item.payload.notebookId,
    tags: item.payload.tags,
  });

  return response.memo;
};

const readMobileSyncQueue = async (): Promise<MobileSyncQueueItem[]> => {
  const rawValue = await AsyncStorage.getItem(SYNC_QUEUE_KEY);

  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(isMobileSyncQueueItem) : [];
  } catch {
    return [];
  }
};

const writeMobileSyncQueue = (items: MobileSyncQueueItem[]) => AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(items));

const updateMobileSyncQueueItem = async (id: string, patch: Partial<MobileSyncQueueItem>) => {
  const items = await readMobileSyncQueue();
  await writeMobileSyncQueue(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
};

const removeMobileSyncQueueItem = async (id: string) => {
  const items = await readMobileSyncQueue();
  await writeMobileSyncQueue(items.filter((item) => item.id !== id));
};

const summarizeMobileSyncQueue = (items: MobileSyncQueueItem[]) =>
  items.reduce((summary, item) => {
    summary.total += 1;
    summary[item.status] += 1;
    return summary;
  }, emptyMobileSyncQueueSummary());

const isMobileSyncQueueItem = (value: unknown): value is MobileSyncQueueItem => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<MobileSyncQueueItem>;
  return item.kind === "memo.update" && typeof item.id === "string" && typeof item.memoId === "string" && Boolean(item.payload);
};

const isRevisionConflict = (error: unknown) => error instanceof ApiRequestError && error.code === "revision_conflict";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Sync failed");

const nextRetryAt = (attemptCount: number) => {
  const delayMs = Math.min(5 * 60_000, 2 ** Math.min(attemptCount, 6) * 1000);
  return new Date(Date.now() + delayMs).toISOString();
};
