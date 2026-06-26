import {
  docToMarkdown,
  type ApiToken,
  type AuthSession,
  type AuthUser,
  type MemoDetail,
  type MemoSummary,
  type Notebook,
  type TagSummary,
  type TiptapDoc,
} from "@edgeever/shared";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  FilePlus2,
  Folder,
  HardDrive,
  History,
  ImageIcon,
  Inbox,
  KeyRound,
  LayoutList,
  LockKeyhole,
  LogOut,
  Merge,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { api } from "@/lib/api";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb } from "@/lib/local-db";
import { buildNotebookTree, cn, formatDateTime, parseTagsText, type NotebookNode } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Pane = "notebooks" | "memos" | "editor";
type MemoView = "notebook" | "trash";

const IMAGE_COMPRESSION_STORAGE_KEY = "edgeever.imageCompressionEnabled";

export const App = () => {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => api.getSession(),
    retry: false,
  });
  const loginMutation = useMutation({
    mutationFn: api.login,
    onSuccess: (session) => {
      queryClient.clear();
      queryClient.setQueryData(["auth", "session"], session);
    },
  });
  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData<AuthSession>(["auth", "session"], {
        authRequired: true,
        authenticated: false,
        user: null,
      });
    },
  });

  useEffect(() => {
    const handleUnauthorized = () => {
      const current = queryClient.getQueryData<AuthSession>(["auth", "session"]);
      queryClient.clear();
      queryClient.setQueryData<AuthSession>(["auth", "session"], {
        authRequired: current?.authRequired ?? true,
        authenticated: false,
        user: null,
      });
    };

    window.addEventListener("edgeever:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("edgeever:unauthorized", handleUnauthorized);
  }, [queryClient]);

  if (sessionQuery.isLoading) {
    return <AuthLoadingScreen />;
  }

  const session = sessionQuery.data;

  if (!session?.authenticated) {
    return (
      <LoginScreen
        error={loginMutation.error instanceof Error ? loginMutation.error.message : null}
        isSubmitting={loginMutation.isPending}
        onSubmit={(payload) => loginMutation.mutate(payload)}
      />
    );
  }

  return (
    <WorkspaceApp
      authRequired={session.authRequired}
      isLoggingOut={logoutMutation.isPending}
      user={session.user}
      onLogout={() => logoutMutation.mutate()}
    />
  );
};

const WorkspaceApp = ({
  authRequired,
  user,
  isLoggingOut,
  onLogout,
}: {
  authRequired: boolean;
  user: AuthUser | null;
  isLoggingOut: boolean;
  onLogout: () => void;
}) => {
  const queryClient = useQueryClient();
  const [activePane, setActivePane] = useState<Pane>("memos");
  const [memoView, setMemoView] = useState<MemoView>("notebook");
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);
  const [selectedMemoIds, setSelectedMemoIds] = useState<Set<string>>(new Set());
  const [multiSelectKeyDown, setMultiSelectKeyDown] = useState(false);
  const [imageCompressionEnabled, setImageCompressionEnabled] = useState(readImageCompressionPreference);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const notebooksQuery = useQuery({
    queryKey: ["notebooks"],
    queryFn: () => api.listNotebooks(),
  });

  const notebooks = notebooksQuery.data?.notebooks ?? [];

  useEffect(() => {
    if (!selectedNotebookId && notebooks.length > 0) {
      setSelectedNotebookId(notebooks[0].id);
    }
  }, [notebooks, selectedNotebookId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.key === "Control" || event.key === "Meta") {
        setMultiSelectKeyDown(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      setMultiSelectKeyDown(event.ctrlKey || event.metaKey);
    };

    const handleBlur = () => setMultiSelectKeyDown(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    writeImageCompressionPreference(imageCompressionEnabled);
  }, [imageCompressionEnabled]);

  const memosQuery = useQuery({
    queryKey: ["memos", memoView, selectedNotebookId, search],
    queryFn: () =>
      api.listMemos({
        notebookId: memoView === "notebook" ? selectedNotebookId : null,
        q: search,
        trash: memoView === "trash",
      }),
    enabled: memoView === "trash" || Boolean(selectedNotebookId),
  });

  const memos = memosQuery.data?.memos ?? [];

  useEffect(() => {
    if (memos.length === 0) {
      setSelectedMemoId(null);
      return;
    }

    if (!selectedMemoId || !memos.some((memo) => memo.id === selectedMemoId)) {
      setSelectedMemoId(memos[0].id);
    }
  }, [memos, selectedMemoId]);

  const memoQuery = useQuery({
    queryKey: ["memo", selectedMemoId, memoView],
    queryFn: () => api.getMemo(selectedMemoId as string, { includeDeleted: memoView === "trash" }),
    enabled: Boolean(selectedMemoId),
  });

  const createNotebookMutation = useMutation({
    mutationFn: api.createNotebook,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["notebooks"] });
      setSelectedNotebookId(data.notebook.id);
      setActivePane("memos");
    },
  });

  const updateNotebookMutation = useMutation({
    mutationFn: ({ notebookId, name }: { notebookId: string; name: string }) =>
      api.updateNotebook(notebookId, { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notebooks"] });
    },
  });

  const deleteNotebookMutation = useMutation({
    mutationFn: api.deleteNotebook,
    onSuccess: async (_data, notebookId) => {
      if (selectedNotebookId === notebookId) {
        setSelectedNotebookId(null);
        setSelectedMemoId(null);
      }

      await queryClient.invalidateQueries({ queryKey: ["notebooks"] });
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
    },
  });

  const createMemoMutation = useMutation({
    mutationFn: api.createMemo,
    onSuccess: async (data) => {
      setMemoView("notebook");
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
      queryClient.setQueryData(["memo", data.memo.id], { memo: data.memo });
      setSelectedMemoId(data.memo.id);
      setActivePane("editor");
    },
  });

  const mergeMutation = useMutation({
    mutationFn: api.mergeMemos,
    onSuccess: async (data) => {
      setSelectedMemoIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
      queryClient.setQueryData(["memo", data.memo.id], { memo: data.memo });
      setSelectedMemoId(data.memo.id);
      setActivePane("editor");
    },
  });

  const deleteMemoMutation = useMutation({
    mutationFn: ({ memoId, permanent }: { memoId: string; permanent?: boolean }) =>
      api.deleteMemo(memoId, { permanent }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
    },
  });

  const restoreMemoMutation = useMutation({
    mutationFn: api.restoreMemo,
    onSuccess: async (data) => {
      setMemoView("notebook");
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
      queryClient.setQueryData(["memo", data.memo.id], { memo: data.memo });
      setSelectedNotebookId(data.memo.notebookId);
      setSelectedMemoId(data.memo.id);
      setActivePane("editor");
    },
  });

  const selectedNotebook = notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null;
  const selectedMemo = memoQuery.data?.memo ?? null;

  const handleCreateNotebook = (parentId?: string | null) => {
    const name = window.prompt("新笔记本名称");

    if (!name?.trim()) {
      return;
    }

    createNotebookMutation.mutate({ name: name.trim(), parentId: parentId ?? null });
  };

  const handleRenameNotebook = (notebook: Notebook) => {
    const name = window.prompt("重命名笔记本", notebook.name);

    if (!name?.trim() || name.trim() === notebook.name) {
      return;
    }

    updateNotebookMutation.mutate({ notebookId: notebook.id, name: name.trim() });
  };

  const handleDeleteNotebook = (notebook: Notebook) => {
    if (notebook.slug === "inbox") {
      window.alert("Inbox 不能删除。");
      return;
    }

    if (!window.confirm(`删除笔记本「${notebook.name}」？请先清空其中的笔记和子笔记本。`)) {
      return;
    }

    deleteNotebookMutation.mutate(notebook.id);
  };

  const handleCreateMemo = () => {
    if (!selectedNotebookId || memoView === "trash") {
      return;
    }

    createMemoMutation.mutate({
      notebookId: selectedNotebookId,
      title: "Untitled memo",
      contentMarkdown: "",
      tags: [],
    });
  };

  const handleMerge = () => {
    if (!selectedNotebookId || selectedMemoIds.size < 2 || memoView === "trash") {
      return;
    }

    mergeMutation.mutate({
      memoIds: Array.from(selectedMemoIds),
      notebookId: selectedNotebookId,
    });
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-emerald-50 text-slate-950">
      <div className="min-w-0 flex-1">
      <main className="grid h-[100dvh] min-h-0 lg:grid-cols-[260px_360px_minmax(0,1fr)]">
        <aside
          className={cn(
            "min-h-0 border-r border-emerald-100 bg-white/90 lg:block",
            activePane === "notebooks" ? "block" : "hidden"
          )}
        >
          <NotebookPane
            authRequired={authRequired}
            user={user}
            notebooks={notebooks}
            selectedNotebookId={selectedNotebookId}
            isLoading={notebooksQuery.isLoading}
            onSelect={(notebookId) => {
              setMemoView("notebook");
              setSelectedNotebookId(notebookId);
              setSelectedMemoIds(new Set());
              setActivePane("memos");
            }}
            onCreateNotebook={handleCreateNotebook}
            onRenameNotebook={handleRenameNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onBackToList={() => setActivePane("memos")}
            onLogout={onLogout}
            isLoggingOut={isLoggingOut}
            imageCompressionEnabled={imageCompressionEnabled}
            onImageCompressionChange={setImageCompressionEnabled}
            onOpenAssets={() => setAssetsOpen(true)}
            onOpenTags={() => setTagsOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenTrash={() => {
              setMemoView("trash");
              setSelectedMemoIds(new Set());
              setSelectedMemoId(null);
              setActivePane("memos");
            }}
          />
        </aside>

        <section
          className={cn(
            "min-h-0 border-r border-emerald-100 bg-emerald-50/80 lg:block",
            activePane === "memos" ? "block" : "hidden"
          )}
        >
          <MemoListPane
            notebook={selectedNotebook}
            view={memoView}
            memos={memos}
            selectedMemoId={selectedMemoId}
            selectedMemoIds={selectedMemoIds}
            search={search}
            isLoading={memosQuery.isLoading}
            isCreating={createMemoMutation.isPending}
            isMerging={mergeMutation.isPending}
            multiSelectKeyDown={multiSelectKeyDown}
            onBackToNotebooks={() => setActivePane("notebooks")}
            onSearch={setSearch}
            onCreateMemo={handleCreateMemo}
            onOpenMemo={(memoId) => {
              setSelectedMemoId(memoId);
              setActivePane("editor");
            }}
            onToggleMemo={(memoId) => {
              setSelectedMemoIds((current) => toggleMemoSelection(current, memoId));
            }}
            onMerge={handleMerge}
          />
        </section>

        <section className={cn("min-h-0 min-w-0 bg-white lg:block", activePane === "editor" ? "block" : "hidden")}>
          <EditorPane
            memo={selectedMemo}
            isTrashView={memoView === "trash"}
            notebooks={notebooks}
            isLoading={memoQuery.isLoading}
            imageCompressionEnabled={imageCompressionEnabled}
            onBackToList={() => setActivePane("memos")}
            onSaved={async (memo) => {
              queryClient.setQueryData(["memo", memo.id], { memo });
              await queryClient.invalidateQueries({ queryKey: ["memos"] });
            }}
            onDeleted={async (memoId) => {
              await deleteMemoMutation.mutateAsync({ memoId });
              setSelectedMemoId(null);
              setActivePane("memos");
            }}
            onPermanentDeleted={async (memoId) => {
              await deleteMemoMutation.mutateAsync({ memoId, permanent: true });
              setSelectedMemoId(null);
              setActivePane("memos");
            }}
            onRestored={async (memoId) => {
              await restoreMemoMutation.mutateAsync(memoId);
            }}
          />
        </section>
      </main>
      </div>
      {assetsOpen ? <AssetsDialog onClose={() => setAssetsOpen(false)} /> : null}
      {tagsOpen ? <TagsDialog onClose={() => setTagsOpen(false)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
};

const AuthLoadingScreen = () => (
  <div className="flex h-[100dvh] items-center justify-center bg-emerald-50 text-sm font-medium text-emerald-900">
    EdgeEver
  </div>
);

const readImageCompressionPreference = () => {
  try {
    return window.localStorage.getItem(IMAGE_COMPRESSION_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

const writeImageCompressionPreference = (enabled: boolean) => {
  try {
    window.localStorage.setItem(IMAGE_COMPRESSION_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
};

const LoginScreen = ({
  error,
  isSubmitting,
  onSubmit,
}: {
  error: string | null;
  isSubmitting: boolean;
  onSubmit: (payload: { username: string; password: string }) => void;
}) => {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!username.trim() || !password) {
      return;
    }

    onSubmit({ username: username.trim(), password });
  };

  return (
    <main className="flex h-[100dvh] items-center justify-center bg-emerald-50 px-4 py-8 text-slate-950">
      <section className="w-full max-w-[380px] rounded-md border border-emerald-100 bg-white p-5 shadow-panel">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-emerald-200 bg-emerald-100 text-emerald-900">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight tracking-normal">登录 EdgeEver</h1>
            <p className="mt-1 text-sm text-slate-500">自托管笔记工作区</p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">账号</span>
            <input
              autoComplete="username"
              className="h-10 w-full rounded-md border border-emerald-100 bg-emerald-50/50 px-3 text-sm outline-none transition focus:border-emerald-300 focus:bg-white"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">密码</span>
            <input
              autoComplete="current-password"
              className="h-10 w-full rounded-md border border-emerald-100 bg-emerald-50/50 px-3 text-sm outline-none transition focus:border-emerald-300 focus:bg-white"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error ? (
            <div className="rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
          ) : null}

          <Button className="w-full justify-center" size="md" type="submit" variant="solid" disabled={isSubmitting}>
            <LockKeyhole className="h-4 w-4" />
            {isSubmitting ? "登录中" : "登录"}
          </Button>
        </form>
      </section>
    </main>
  );
};

const toggleMemoSelection = (current: Set<string>, memoId: string) => {
  const next = new Set(current);

  if (next.has(memoId)) {
    next.delete(memoId);
  } else {
    next.add(memoId);
  }

  return next;
};

const NotebookPane = ({
  authRequired,
  user,
  notebooks,
  selectedNotebookId,
  isLoading,
  onSelect,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onBackToList,
  onLogout,
  isLoggingOut,
  imageCompressionEnabled,
  onImageCompressionChange,
  onOpenAssets,
  onOpenTags,
  onOpenSettings,
  onOpenTrash,
}: {
  authRequired: boolean;
  user: AuthUser | null;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  isLoading: boolean;
  onSelect: (notebookId: string) => void;
  onCreateNotebook: (parentId?: string | null) => void;
  onRenameNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onBackToList: () => void;
  onLogout: () => void;
  isLoggingOut: boolean;
  imageCompressionEnabled: boolean;
  onImageCompressionChange: (enabled: boolean) => void;
  onOpenAssets: () => void;
  onOpenTags: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
}) => {
  const tree = useMemo(() => buildNotebookTree(notebooks), [notebooks]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end justify-between border-b border-emerald-100 px-4 pb-3 pt-[env(safe-area-inset-top)] lg:h-16 lg:items-center lg:pb-0 lg:pt-0">
        <div>
          <div className="text-base font-semibold tracking-normal lg:hidden">笔记本</div>
          <div className="hidden text-base font-semibold tracking-normal lg:block">EdgeEver</div>
          <div className="text-xs text-slate-500">{user?.username ?? "Cloudflare-native notes"}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button className="lg:hidden" size="icon" variant="ghost" title="返回笔记列表" onClick={onBackToList}>
            <LayoutList className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="新建笔记本" onClick={() => onCreateNotebook(null)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-3 flex items-center gap-2 px-2 text-xs font-semibold uppercase text-slate-500">
          <Folder className="h-4 w-4" />
          Notebooks
        </div>

        {isLoading ? (
          <div className="px-2 py-3 text-sm text-slate-500">加载中</div>
        ) : (
          <div className="space-y-1">
            {tree.map((node) => (
              <NotebookTreeItem
                key={node.id}
                node={node}
                depth={0}
                selectedNotebookId={selectedNotebookId}
                onSelect={onSelect}
                onCreateNotebook={onCreateNotebook}
                onRenameNotebook={onRenameNotebook}
                onDeleteNotebook={onDeleteNotebook}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-emerald-100 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <label className="mb-3 flex min-h-10 items-center justify-between gap-3 rounded-md border border-emerald-100 bg-emerald-50/70 px-3 py-2">
          <span className="min-w-0 text-sm font-medium text-slate-700">压缩图片</span>
          <input
            type="checkbox"
            checked={imageCompressionEnabled}
            onChange={(event) => onImageCompressionChange(event.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-emerald-300 text-emerald-600"
            aria-label="粘贴图片时自动压缩"
          />
        </label>
        <div className={cn("grid gap-2", authRequired ? "grid-cols-5" : "grid-cols-4")}>
          <Button size="icon" variant="ghost" title="标签" onClick={onOpenTags}>
            <Tags className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="资产" onClick={onOpenAssets}>
            <Archive className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="回收站" onClick={onOpenTrash}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="设置" onClick={onOpenSettings}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {authRequired ? (
            <Button size="icon" variant="ghost" title="退出登录" onClick={onLogout} disabled={isLoggingOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
};

const NotebookTreeItem = ({
  node,
  depth,
  selectedNotebookId,
  onSelect,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
}: {
  node: NotebookNode;
  depth: number;
  selectedNotebookId: string | null;
  onSelect: (notebookId: string) => void;
  onCreateNotebook: (parentId?: string | null) => void;
  onRenameNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
}) => {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const selected = node.id === selectedNotebookId;
  const isInbox = node.slug === "inbox";

  return (
    <div>
      <div
        className={cn(
          "group flex h-9 items-center gap-1 rounded-md px-2 text-sm transition",
          selected ? "border border-emerald-200 bg-emerald-100 text-emerald-950" : "text-slate-700 hover:bg-emerald-50"
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          className="flex h-6 w-5 items-center justify-center rounded"
          onClick={() => setOpen((value) => !value)}
          title={hasChildren ? "展开/折叠" : undefined}
        >
          {hasChildren ? (
            open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
          ) : (
            <span className="h-4 w-4" />
          )}
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(node.id)}>
          {node.slug === "inbox" ? <Inbox className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        <button
          className={cn(
            "hidden h-6 w-6 items-center justify-center rounded-md group-hover:flex",
            selected ? "hover:bg-emerald-200" : "hover:bg-emerald-100"
          )}
          title="新建子笔记本"
          onClick={(event) => {
            event.stopPropagation();
            onCreateNotebook(node.id);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          className={cn(
            "hidden h-6 w-6 items-center justify-center rounded-md group-hover:flex",
            selected ? "hover:bg-emerald-200" : "hover:bg-emerald-100"
          )}
          title="重命名笔记本"
          onClick={(event) => {
            event.stopPropagation();
            onRenameNotebook(node);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {!isInbox ? (
          <button
            className="hidden h-6 w-6 items-center justify-center rounded-md text-rose-600 hover:bg-rose-50 group-hover:flex"
            title="删除笔记本"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteNotebook(node);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {hasChildren && open ? (
        <div className="mt-1 space-y-1">
          {node.children.map((child) => (
            <NotebookTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNotebookId={selectedNotebookId}
              onSelect={onSelect}
              onCreateNotebook={onCreateNotebook}
              onRenameNotebook={onRenameNotebook}
              onDeleteNotebook={onDeleteNotebook}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const MemoListPane = ({
  notebook,
  view,
  memos,
  selectedMemoId,
  selectedMemoIds,
  search,
  isLoading,
  isCreating,
  isMerging,
  multiSelectKeyDown,
  onBackToNotebooks,
  onSearch,
  onCreateMemo,
  onOpenMemo,
  onToggleMemo,
  onMerge,
}: {
  notebook: Notebook | null;
  view: MemoView;
  memos: MemoSummary[];
  selectedMemoId: string | null;
  selectedMemoIds: Set<string>;
  search: string;
  isLoading: boolean;
  isCreating: boolean;
  isMerging: boolean;
  multiSelectKeyDown: boolean;
  onBackToNotebooks: () => void;
  onSearch: (value: string) => void;
  onCreateMemo: () => void;
  onOpenMemo: (memoId: string) => void;
  onToggleMemo: (memoId: string) => void;
  onMerge: () => void;
}) => (
  <div className="relative flex h-full min-h-0 flex-col">
    <header className="border-b border-emerald-100 bg-white px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button className="lg:hidden" size="icon" variant="ghost" title="打开笔记本" onClick={onBackToNotebooks}>
            <PanelLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-slate-950 lg:text-sm">
              {view === "trash" ? "回收站" : notebook?.name ?? "全部笔记"}
            </div>
            <div className="text-xs text-slate-500">
              {memos.length} {view === "trash" ? "trashed" : "memos"}
            </div>
          </div>
        </div>
        <Button
          className="hidden lg:inline-flex"
          size="icon"
          variant="solid"
          title="新建笔记"
          onClick={onCreateMemo}
          disabled={!notebook || isCreating || view === "trash"}
        >
          <FilePlus2 className="h-4 w-4" />
        </Button>
      </div>
      <label className="flex h-9 items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50/70 px-3 text-sm text-slate-500">
        <Search className="h-4 w-4" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
          placeholder="Search memos"
        />
      </label>
    </header>

    <div className="relative min-h-0 flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {selectedMemoIds.size > 0 ? (
        <div className="sticky top-0 z-10 mb-3 flex items-center justify-between rounded-md border border-emerald-100 bg-white px-3 py-2 shadow-panel">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckSquare className="h-4 w-4 text-emerald-700" />
            {selectedMemoIds.size} selected
          </div>
          <Button
            size="sm"
            variant="solid"
            onClick={onMerge}
            disabled={selectedMemoIds.size < 2 || isMerging || view === "trash"}
          >
            <Merge className="h-4 w-4" />
            合并
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="px-2 py-4 text-sm text-slate-500">加载中</div>
      ) : memos.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
          {view === "trash" ? "回收站为空" : "No memos"}
        </div>
      ) : (
        <div className="space-y-2">
          {memos.map((memo) => (
            <MemoCard
              key={memo.id}
              memo={memo}
              selected={memo.id === selectedMemoId}
              checked={selectedMemoIds.has(memo.id)}
              multiSelectKeyDown={multiSelectKeyDown}
              onOpen={() => onOpenMemo(memo.id)}
              onToggle={() => onToggleMemo(memo.id)}
            />
          ))}
        </div>
      )}
    </div>
    {selectedMemoIds.size === 0 ? (
      <button
        className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 flex h-14 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-100 px-5 text-sm font-semibold text-emerald-950 shadow-panel transition hover:bg-emerald-200 disabled:opacity-50 lg:hidden"
        title="新建笔记"
        onClick={onCreateMemo}
        disabled={!notebook || isCreating}
        hidden={view === "trash"}
      >
        <FilePlus2 className="h-5 w-5" />
        新建
      </button>
    ) : null}
  </div>
);

const MemoCard = ({
  memo,
  selected,
  checked,
  multiSelectKeyDown,
  onOpen,
  onToggle,
}: {
  memo: MemoSummary;
  selected: boolean;
  checked: boolean;
  multiSelectKeyDown: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) => {
  const handledModifierPointerRef = useRef(false);

  const shouldToggleSelection = (event: MouseEvent<HTMLElement>) =>
    event.ctrlKey || event.metaKey || multiSelectKeyDown;

  const markModifierPointerHandled = () => {
    handledModifierPointerRef.current = true;
    window.setTimeout(() => {
      handledModifierPointerRef.current = false;
    }, 450);
  };

  const handleModifierToggle = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    markModifierPointerHandled();
    onToggle();
  };

  const handleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    if (shouldToggleSelection(event)) {
      handleModifierToggle(event);
    }
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (handledModifierPointerRef.current) {
      event.preventDefault();
      event.stopPropagation();
      handledModifierPointerRef.current = false;
      return;
    }

    if (shouldToggleSelection(event)) {
      handleModifierToggle(event);
      return;
    }

    onOpen();
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (!shouldToggleSelection(event) && !handledModifierPointerRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!handledModifierPointerRef.current) {
      markModifierPointerHandled();
      onToggle();
    }
  };

  return (
    <article
      className={cn(
        "rounded-md border bg-white p-3 transition",
        selected ? "border-emerald-300 shadow-panel" : "border-emerald-100 hover:border-emerald-200",
        checked && "border-emerald-300 bg-emerald-50/70"
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 h-5 w-5 shrink-0 rounded border-emerald-300 text-emerald-600"
          aria-label={`选择 ${memo.title ?? memo.excerpt}`}
        />
        <button
          className={cn("min-w-0 flex-1 text-left", multiSelectKeyDown && "cursor-copy")}
          onMouseDown={handleMouseDown}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title="Ctrl/Cmd 点击切换选择"
        >
          <div className="mb-1 truncate text-sm font-semibold text-slate-950">{memo.title || "Untitled memo"}</div>
          <div className="line-clamp-2 min-h-[40px] text-sm leading-5 text-slate-600">{memo.excerpt || "Empty memo"}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <time className="text-xs text-slate-400">{formatDateTime(memo.updatedAt)}</time>
            {memo.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                #{tag}
              </span>
            ))}
          </div>
        </button>
      </div>
    </article>
  );
};

const SUPPORTED_PASTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

const getImageFilesFromDataTransfer = (dataTransfer: DataTransfer | null) => {
  if (!dataTransfer) {
    return [];
  }

  const fileItems = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const files = fileItems.length > 0 ? fileItems : Array.from(dataTransfer.files ?? []);

  return files.filter((file) => SUPPORTED_PASTE_IMAGE_TYPES.has(file.type));
};

const AssetsDialog = ({ onClose }: { onClose: () => void }) => {
  const resourcesQuery = useQuery({
    queryKey: ["resources"],
    queryFn: () => api.listResources(),
  });
  const resources = resourcesQuery.data?.resources ?? [];
  const summary = resourcesQuery.data?.summary ?? {
    totalCount: 0,
    totalBytes: 0,
    imageCount: 0,
    attachmentCount: 0,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6">
      <section className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[760px] sm:rounded-md">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <Archive className="h-4 w-4 text-emerald-700" />
              附件
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <HardDrive className="h-3.5 w-3.5" />
                {formatBytes(summary.totalBytes)}
              </span>
              <span>{summary.totalCount} files</span>
              <span>{summary.imageCount} images</span>
            </div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {resourcesQuery.isLoading ? (
            <div className="px-2 py-8 text-center text-sm text-slate-500">加载中</div>
          ) : resources.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              暂无附件
            </div>
          ) : (
            <div className="space-y-2">
              {resources.map((resource) => (
                <a
                  key={resource.id}
                  className="flex min-h-16 items-center gap-3 rounded-md border border-emerald-100 bg-emerald-50/30 px-3 py-2 text-left transition hover:border-emerald-200 hover:bg-emerald-50"
                  href={resource.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-emerald-100 bg-white text-emerald-700">
                    {resource.kind === "image" ? <ImageIcon className="h-5 w-5" /> : <FileIcon className="h-5 w-5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-950">
                      {resource.filename || resource.id}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-500">
                      {formatBytes(resource.byteSize)} · {resource.mimeType ?? resource.kind} ·{" "}
                      {formatDateTime(resource.createdAt)}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {resource.memoDeleted
                        ? "已删除笔记"
                        : resource.memoTitle || resource.memoExcerpt || resource.memoId}
                    </span>
                  </span>
                  <ExternalLink className="h-4 w-4 shrink-0 text-slate-400" />
                </a>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

const TagsDialog = ({ onClose }: { onClose: () => void }) => {
  const queryClient = useQueryClient();
  const tagsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.listTags(),
  });
  const renameMutation = useMutation({
    mutationFn: ({ tag, name }: { tag: string; name: string }) => api.renameTag(tag, name),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["memos"] }),
        queryClient.invalidateQueries({ queryKey: ["memo"] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteTag,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["memos"] }),
        queryClient.invalidateQueries({ queryKey: ["memo"] }),
      ]);
    },
  });
  const tags = tagsQuery.data?.tags ?? [];

  const handleRename = (tag: TagSummary) => {
    const name = window.prompt("重命名标签", tag.name);

    if (!name?.trim() || name.trim() === tag.name) {
      return;
    }

    renameMutation.mutate({ tag: tag.name, name: name.trim() });
  };

  const handleDelete = (tag: TagSummary) => {
    if (!window.confirm(`从 ${tag.memoCount} 条笔记中移除标签 #${tag.name}？`)) {
      return;
    }

    deleteMutation.mutate(tag.name);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6">
      <section className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[680px] sm:rounded-md">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <Tags className="h-4 w-4 text-emerald-700" />
              标签
            </div>
            <div className="mt-1 truncate text-xs text-slate-500">{tags.length} tags</div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {tagsQuery.isLoading ? (
            <div className="px-2 py-8 text-center text-sm text-slate-500">加载中</div>
          ) : tags.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              暂无标签
            </div>
          ) : (
            <div className="space-y-2">
              {tags.map((tag) => (
                <div
                  key={tag.name}
                  className="flex min-h-12 items-center gap-3 rounded-md border border-emerald-100 bg-emerald-50/30 px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-950">#{tag.name}</span>
                    <span className="mt-1 block text-xs text-slate-500">
                      {tag.memoCount} memos{tag.updatedAt ? ` · ${formatDateTime(tag.updatedAt)}` : ""}
                    </span>
                  </span>
                  <Button size="icon" variant="ghost" title="重命名标签" onClick={() => handleRename(tag)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="danger" title="删除标签" onClick={() => handleDelete(tag)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

const DEFAULT_TOKEN_SCOPES = ["read:notebooks", "read:memos", "read:tags"];

const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Local Agent");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(() => new Set(DEFAULT_TOKEN_SCOPES));
  const [createdToken, setCreatedToken] = useState<{ token: string; apiToken: ApiToken } | null>(null);
  const tokensQuery = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.listApiTokens(),
  });
  const availableScopes = tokensQuery.data?.availableScopes ?? [
    "read:notebooks",
    "write:notebooks",
    "read:memos",
    "write:memos",
    "read:resources",
    "write:resources",
    "read:tags",
    "write:tags",
  ];
  const createMutation = useMutation({
    mutationFn: api.createApiToken,
    onSuccess: async (data) => {
      setCreatedToken(data);
      setName("");
      setSelectedScopes(new Set(DEFAULT_TOKEN_SCOPES));
      await queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: api.revokeApiToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
  const tokens = tokensQuery.data?.apiTokens ?? [];

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) => {
      const next = new Set(current);

      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }

      return next;
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const scopes = Array.from(selectedScopes);

    if (!name.trim() || scopes.length === 0) {
      return;
    }

    createMutation.mutate({ name: name.trim(), scopes });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6">
      <section className="flex max-h-[92dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[820px] sm:rounded-md">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <KeyRound className="h-4 w-4 text-emerald-700" />
              设置
            </div>
            <div className="mt-1 truncate text-xs text-slate-500">API Token / MCP / CLI</div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {createdToken ? (
            <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-950">
                <ShieldCheck className="h-4 w-4" />
                Token 已生成
              </div>
              <div className="flex gap-2">
                <input
                  className="h-9 min-w-0 flex-1 rounded-md border border-emerald-200 bg-white px-3 font-mono text-xs text-slate-900 outline-none"
                  readOnly
                  value={createdToken.token}
                />
                <Button
                  size="sm"
                  variant="solid"
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(createdToken.token)}
                >
                  复制
                </Button>
              </div>
              <div className="mt-2 text-xs text-emerald-800">明文 Token 只显示这一次。</div>
            </div>
          ) : null}

          <form className="mb-5 rounded-md border border-emerald-100 bg-emerald-50/30 p-3" onSubmit={handleSubmit}>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row">
              <input
                className="h-9 min-w-0 flex-1 rounded-md border border-emerald-100 bg-white px-3 text-sm outline-none focus:border-emerald-300"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Token 名称"
              />
              <Button size="md" variant="solid" type="submit" disabled={createMutation.isPending}>
                <KeyRound className="h-4 w-4" />
                生成 Token
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {availableScopes.map((scope) => (
                <label
                  key={scope}
                  className="flex min-h-9 items-center gap-2 rounded-md border border-emerald-100 bg-white px-2 text-sm text-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                    className="h-4 w-4 shrink-0 rounded border-emerald-300 text-emerald-600"
                  />
                  <span className="min-w-0 truncate font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </form>

          <div className="space-y-2">
            {tokensQuery.isLoading ? (
              <div className="px-2 py-8 text-center text-sm text-slate-500">加载中</div>
            ) : tokens.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                暂无 API Token
              </div>
            ) : (
              tokens.map((token) => (
                <div
                  key={token.id}
                  className={cn(
                    "flex min-h-16 items-center gap-3 rounded-md border px-3 py-2",
                    token.isRevoked ? "border-slate-200 bg-slate-50 opacity-70" : "border-emerald-100 bg-white"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-950">{token.name}</span>
                    <span className="mt-1 block truncate text-xs text-slate-500">
                      {token.scopes.join(", ") || "no scopes"}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      {token.lastUsedAt ? `Last used ${formatDateTime(token.lastUsedAt)}` : "Never used"}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={token.isRevoked || revokeMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`撤销 Token「${token.name}」？`)) {
                        revokeMutation.mutate(token.id);
                      }
                    }}
                  >
                    撤销
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${exponent === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[exponent]}`;
};

const RevisionHistoryDialog = ({
  memo,
  currentMarkdown,
  onClose,
  onRestored,
}: {
  memo: MemoDetail;
  currentMarkdown: string;
  onClose: () => void;
  onRestored: (memo: MemoDetail) => Promise<void>;
}) => {
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const revisionsQuery = useQuery({
    queryKey: ["memo-revisions", memo.id],
    queryFn: () => api.listMemoRevisions(memo.id),
  });
  const revisions = revisionsQuery.data?.revisions ?? [];
  const selectedRevision =
    revisions.find((revision) => revision.id === selectedRevisionId) ?? revisions[0] ?? null;
  const diffSummary = useMemo(
    () => summarizeMarkdownDiff(selectedRevision?.contentMarkdown ?? "", currentMarkdown),
    [currentMarkdown, selectedRevision?.contentMarkdown]
  );
  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => api.restoreMemoRevision(memo.id, revisionId),
    onSuccess: async (data) => {
      await onRestored(data.memo);
    },
  });

  useEffect(() => {
    if (!selectedRevisionId && revisions.length > 0) {
      setSelectedRevisionId(revisions[0].id);
    }
  }, [revisions, selectedRevisionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6">
      <section className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[980px] sm:rounded-md">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <History className="h-4 w-4 text-emerald-700" />
              版本历史
            </div>
            <div className="mt-1 truncate text-xs text-slate-500">{memo.title || "Untitled memo"}</div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[280px_minmax(0,1fr)] sm:grid-rows-1">
          <aside className="min-h-0 border-b border-emerald-100 p-3 sm:border-b-0 sm:border-r">
            {revisionsQuery.isLoading ? (
              <div className="px-2 py-8 text-center text-sm text-slate-500">加载中</div>
            ) : revisions.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                暂无历史版本
              </div>
            ) : (
              <div className="max-h-44 space-y-2 overflow-y-auto sm:max-h-none">
                {revisions.map((revision) => (
                  <button
                    key={revision.id}
                    className={cn(
                      "block w-full rounded-md border px-3 py-2 text-left transition",
                      selectedRevision?.id === revision.id
                        ? "border-emerald-300 bg-emerald-50"
                        : "border-emerald-100 hover:border-emerald-200 hover:bg-emerald-50/50"
                    )}
                    onClick={() => setSelectedRevisionId(revision.id)}
                  >
                    <span className="block text-sm font-semibold text-slate-950">
                      Revision {revision.revision}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-500">
                      {formatDateTime(revision.createdAt)}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-400">
                      {formatRevisionActor(revision.createdBy)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-emerald-100 px-4 py-3">
              <div className="text-xs font-medium text-slate-500">
                {selectedRevision ? `${diffSummary.changed} changed lines` : "No revision selected"}
              </div>
              <Button
                size="sm"
                variant="solid"
                disabled={!selectedRevision || memo.isDeleted || restoreMutation.isPending}
                onClick={() => {
                  if (selectedRevision && window.confirm("恢复到这个历史版本？")) {
                    restoreMutation.mutate(selectedRevision.id);
                  }
                }}
              >
                <RotateCcw className="h-4 w-4" />
                恢复该版本
              </Button>
            </div>

            <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto sm:grid-cols-2">
              <RevisionPreview title="历史版本" markdown={selectedRevision?.contentMarkdown ?? ""} />
              <RevisionPreview title="当前内容" markdown={currentMarkdown} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

const RevisionPreview = ({ title, markdown }: { title: string; markdown: string }) => (
  <div className="min-h-[260px] border-b border-emerald-100 p-4 sm:border-b-0 sm:border-r">
    <div className="mb-3 text-xs font-semibold uppercase text-slate-500">{title}</div>
    <pre className="max-h-[54dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-emerald-100 bg-emerald-50/30 p-3 text-sm leading-6 text-slate-700">
      {markdown || "Empty memo"}
    </pre>
  </div>
);

const summarizeMarkdownDiff = (left: string, right: string) => {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const maxLines = Math.max(leftLines.length, rightLines.length);
  let changed = 0;

  for (let index = 0; index < maxLines; index += 1) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) {
      changed += 1;
    }
  }

  return { changed };
};

const formatRevisionActor = (actor: string) => {
  if (actor.startsWith("user:")) {
    return "user";
  }

  if (actor.startsWith("agent:")) {
    return "agent";
  }

  return actor || "system";
};

const EditorPane = ({
  memo,
  isTrashView,
  notebooks,
  isLoading,
  imageCompressionEnabled,
  onBackToList,
  onSaved,
  onDeleted,
  onPermanentDeleted,
  onRestored,
}: {
  memo: MemoDetail | null;
  isTrashView: boolean;
  notebooks: Notebook[];
  isLoading: boolean;
  imageCompressionEnabled: boolean;
  onBackToList: () => void;
  onSaved: (memo: MemoDetail) => Promise<void>;
  onDeleted: (memoId: string) => Promise<void>;
  onPermanentDeleted: (memoId: string) => Promise<void>;
  onRestored: (memoId: string) => Promise<void>;
}) => {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [imageUploadState, setImageUploadState] = useState<"idle" | "compressing" | "uploading" | "error">("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const memoRef = useRef<MemoDetail | null>(memo);
  const editorRef = useRef<Editor | null>(null);
  const hydratingRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const editingMemoIdRef = useRef<string | null>(memo?.id ?? null);
  const imageCompressionEnabledRef = useRef(imageCompressionEnabled);
  const insertImageFiles = useCallback((files: File[]) => {
    const currentMemo = memoRef.current;
    const currentEditor = editorRef.current;

    if (!currentMemo || currentMemo.isDeleted || !currentEditor || files.length === 0) {
      return;
    }

    const targetMemoId = currentMemo.id;

    void (async () => {
      setImageUploadState("uploading");

      try {
        for (const file of files) {
          const shouldCompress = imageCompressionEnabledRef.current;
          setImageUploadState(shouldCompress ? "compressing" : "uploading");
          const uploadFile = shouldCompress ? (await compressImageForUpload(file)).file : file;

          setImageUploadState("uploading");
          const { resource } = await api.uploadMemoResource(targetMemoId, uploadFile);
          void queryClient.invalidateQueries({ queryKey: ["resources"] });

          if (memoRef.current?.id !== targetMemoId || !editorRef.current) {
            setImageUploadState("idle");
            return;
          }

          editorRef.current
            .chain()
            .focus()
            .setImage({
              src: resource.url,
              alt: file.name,
              title: file.name,
            })
            .run();
        }

        setImageUploadState("idle");
      } catch {
        setImageUploadState("error");
        window.setTimeout(() => setImageUploadState("idle"), 2200);
      }
    })();
  }, [queryClient]);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({
        allowBase64: false,
        inline: false,
      }),
      Placeholder.configure({
        placeholder: "Start writing...",
      }),
    ],
    content: memo?.contentJson ?? { type: "doc", content: [{ type: "paragraph" }] },
    editable: !memo?.isDeleted,
    editorProps: {
      attributes: {
        class: "prose prose-slate max-w-none",
      },
      handlePaste: (_view, event) => {
        const files = getImageFilesFromDataTransfer(event.clipboardData);

        if (files.length === 0) {
          return false;
        }

        event.preventDefault();
        insertImageFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = getImageFilesFromDataTransfer(event.dataTransfer);

        if (files.length === 0) {
          return false;
        }

        event.preventDefault();
        insertImageFiles(files);
        return true;
      },
    },
  });

  useEffect(() => {
    imageCompressionEnabledRef.current = imageCompressionEnabled;
  }, [imageCompressionEnabled]);

  useEffect(() => {
    editorRef.current = editor;

    return () => {
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
    };
  }, [editor]);

  const persistCurrentDraft = useCallback(
    (nextTitle = title, nextTagsText = tagsText) => {
      const currentMemo = memoRef.current;
      const currentEditor = editorRef.current;

      if (!currentMemo || currentMemo.isDeleted || !currentEditor) {
        return;
      }

      void localDb.drafts.put({
        memoId: currentMemo.id,
        title: nextTitle,
        tagsText: nextTagsText,
        contentJson: currentEditor.getJSON() as TiptapDoc,
        updatedAt: new Date().toISOString(),
      });
    },
    [tagsText, title]
  );

  const markDirty = useCallback(() => {
    const currentMemo = memoRef.current;

    if (hydratingRef.current || currentMemo?.isDeleted) {
      return;
    }

    hasUnsavedChangesRef.current = true;
    setHasUnsavedChanges(true);
    setDirtyVersion((version) => version + 1);
    setSaveState((current) => (current === "conflict" ? current : "idle"));
  }, []);

  const currentSnapshot = useCallback(() => {
    const currentEditor = editorRef.current;

    if (!currentEditor) {
      return null;
    }

    return JSON.stringify({
      title,
      tagsText,
      contentJson: currentEditor.getJSON(),
    });
  }, [tagsText, title]);

  useEffect(() => {
    const currentEditor = editorRef.current;

    if (!memo) {
      memoRef.current = null;
      editingMemoIdRef.current = null;
      hasUnsavedChangesRef.current = false;
      setHasUnsavedChanges(false);
      setTitle("");
      setTagsText("");
      setSaveState("idle");
      currentEditor?.commands.clearContent();
      return;
    }

    const sameMemo = editingMemoIdRef.current === memo.id;
    memoRef.current = memo;
    currentEditor?.setEditable(!memo.isDeleted);

    if (sameMemo && hasUnsavedChangesRef.current && !memo.isDeleted) {
      return;
    }

    hydratingRef.current = true;
    editingMemoIdRef.current = memo.id;
    hasUnsavedChangesRef.current = false;
    setHasUnsavedChanges(false);
    setSaveState("idle");
    setTitle(memo.title ?? "");
    setTagsText(memo.tags.join(", "));

    if (currentEditor) {
      currentEditor.commands.setContent(memo.contentJson);
    }

    window.setTimeout(() => {
      hydratingRef.current = false;
    }, 0);
  }, [memo, editor]);

  useEffect(() => {
    if (!editor || !memo) {
      return;
    }

    const persistDraft = () => {
      if (hydratingRef.current || memoRef.current?.isDeleted) {
        return;
      }

      persistCurrentDraft();
      markDirty();
    };

    editor.on("update", persistDraft);
    return () => {
      editor.off("update", persistDraft);
    };
  }, [editor, markDirty, memo, persistCurrentDraft]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const currentMemo = memoRef.current;
      const currentEditor = editorRef.current;

      if (!currentMemo || !currentEditor) {
        throw new Error("No memo selected");
      }

      if (currentMemo.isDeleted) {
        throw new Error("Deleted memos are read-only");
      }

      const snapshot = currentSnapshot();

      if (!snapshot) {
        throw new Error("Editor is not ready");
      }

      const data = await api.updateMemo(currentMemo.id, {
        expectedRevision: currentMemo.revision,
        title,
        contentJson: currentEditor.getJSON() as TiptapDoc,
        tags: parseTagsText(tagsText),
      });

      return { memo: data.memo, snapshot };
    },
    onMutate: () => setSaveState("saving"),
    onSuccess: async ({ memo: savedMemo, snapshot }) => {
      memoRef.current = savedMemo;
      await onSaved(savedMemo);

      if (currentSnapshot() === snapshot) {
        hasUnsavedChangesRef.current = false;
        setHasUnsavedChanges(false);
        await localDb.drafts.delete(savedMemo.id);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1400);
        return;
      }

      persistCurrentDraft();
      hasUnsavedChangesRef.current = true;
      setHasUnsavedChanges(true);
      setSaveState("idle");
    },
    onError: (error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      setSaveState(code === "revision_conflict" ? "conflict" : "error");
    },
  });

  useEffect(() => {
    if (
      !memo ||
      memo.isDeleted ||
      !editor ||
      !hasUnsavedChanges ||
      saveMutation.isPending ||
      saveState === "conflict"
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      saveMutation.mutate();
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [dirtyVersion, editor, hasUnsavedChanges, memo, saveMutation, saveState]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">加载中</div>;
  }

  if (!memo) {
    return (
      <div className="flex h-full items-center justify-center bg-white px-8 text-center">
        <div>
          <Sparkles className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          <div className="text-sm font-medium text-slate-700">Select or create a memo</div>
        </div>
      </div>
    );
  }

  const readOnly = isTrashView || memo.isDeleted;
  const saveLabel =
    saveState === "saving"
      ? "保存中"
      : saveState === "saved"
        ? "已保存"
        : saveState === "conflict"
          ? "有冲突"
          : saveState === "error"
            ? "保存失败"
            : hasUnsavedChanges
              ? "未保存"
              : "已保存";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="shrink-0 border-b border-emerald-100 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Button className="lg:hidden" size="icon" variant="ghost" title="返回列表" onClick={onBackToList}>
              <LayoutList className="h-4 w-4" />
            </Button>
            <select
              value={memo.notebookId}
              className="h-8 min-w-0 max-w-[170px] rounded-md border border-emerald-100 bg-emerald-50/70 px-2 text-xs text-emerald-900 outline-none sm:max-w-none"
              disabled={readOnly}
              onChange={(event) => {
                void api
                  .updateMemo(memo.id, {
                    expectedRevision: memo.revision,
                    notebookId: event.target.value,
                  })
                  .then((data) => onSaved(data.memo));
              }}
            >
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            {imageUploadState !== "idle" ? (
              <span
                className={cn(
                  "hidden rounded-md px-2 py-1 text-xs font-medium sm:inline-flex",
                  imageUploadState === "error"
                    ? "bg-rose-50 text-rose-700"
                    : "bg-emerald-50 text-emerald-700"
                )}
              >
                {imageUploadState === "error"
                  ? "图片上传失败"
                  : imageUploadState === "compressing"
                    ? "图片压缩中"
                    : "图片上传中"}
              </span>
            ) : null}
            <Button size="sm" variant="ghost" title="版本历史" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
            </Button>
            {readOnly ? (
              <>
                <Button size="sm" variant="solid" title="恢复笔记" onClick={() => void onRestored(memo.id)}>
                  <RotateCcw className="h-4 w-4" />
                  恢复
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="彻底删除"
                  onClick={() => {
                    if (window.confirm("彻底删除后无法恢复，确认继续吗？")) {
                      void onPermanentDeleted(memo.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" title="删除笔记" onClick={() => void onDeleted(memo.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="solid"
                  onClick={() => saveMutation.mutate()}
                  disabled={!editor || saveMutation.isPending || !hasUnsavedChanges}
                >
                  <Save className="h-4 w-4" />
                  {saveLabel}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="space-y-3 px-4 pb-4 sm:px-7">
          <input
            value={title}
            readOnly={readOnly}
            onChange={(event) => {
              setTitle(event.target.value);
              persistCurrentDraft(event.target.value, tagsText);
              markDirty();
            }}
            className="block w-full border-0 bg-transparent text-2xl font-semibold leading-tight text-slate-950 outline-none placeholder:text-slate-300 sm:text-3xl"
            placeholder="Untitled memo"
          />
          <label className="flex h-8 items-center gap-2 text-sm text-slate-500">
            <Tags className="h-4 w-4" />
            <input
              value={tagsText}
              readOnly={readOnly}
              onChange={(event) => {
                setTagsText(event.target.value);
                persistCurrentDraft(title, event.target.value);
                markDirty();
              }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400"
              placeholder="tags"
            />
          </label>
        </div>
      </header>

      <div className="edgeever-editor min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
      {historyOpen ? (
        <RevisionHistoryDialog
          currentMarkdown={editor ? docToMarkdown(editor.getJSON() as TiptapDoc) : memo.contentMarkdown}
          memo={memo}
          onClose={() => setHistoryOpen(false)}
          onRestored={async (restoredMemo) => {
            await localDb.drafts.delete(restoredMemo.id);
            hasUnsavedChangesRef.current = false;
            setHasUnsavedChanges(false);
            await onSaved(restoredMemo);
            setHistoryOpen(false);
          }}
        />
      ) : null}
    </div>
  );
};
