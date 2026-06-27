import {
  DEFAULT_MEMO_TITLE,
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
  ArrowDownWideNarrow,
  Bold,
  Check,
  ChevronLeft,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Code2,
  AlertTriangle,
  CloudOff,
  ExternalLink,
  File as FileIcon,
  FilePlus2,
  Folder,
  HardDrive,
  History,
  Home,
  ImageIcon,
  Inbox,
  Italic,
  KeyRound,
  LayoutList,
  List,
  ListOrdered,
  LockKeyhole,
  LogOut,
  Merge,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Plus,
  Quote,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  SquareCode,
  Star,
  Strikethrough,
  TagX,
  Tags,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb, type MemoUpdateSyncPayload } from "@/lib/local-db";
import {
  emptySyncQueueSummary,
  getMemoUpdateQueueId,
  observeSyncQueue,
  queueMemoUpdate,
  shouldQueueMemoSaveError,
  syncQueuedChanges,
  type SyncQueueSummary,
} from "@/lib/sync-queue";
import { buildNotebookTree, cn, formatDateTime, parseTagsText, type NotebookNode } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Pane = "notebooks" | "memos" | "editor";
type MemoView = "notebook" | "trash";
type MemoFilterMode = "all" | "tagged" | "untagged" | "pinned";
type MemoSortMode = "updated-desc" | "created-desc" | "title-asc";
type MemoListDensity = "preview" | "compact";
type MobileBottomNavItem = "home" | "search" | "templates" | "settings";
type MemoContextMenuState = { memo: MemoSummary; x: number; y: number };
type NotebookDropPosition = "before" | "inside" | "after";
type NotebookMoveOption = { id: string; name: string; selectLabel: string; slug: string | null; depth: number };
type MemoTemplate = {
  id: string;
  title: string;
  description: string;
  contentMarkdown: string;
  tags: string[];
};

const IMAGE_COMPRESSION_STORAGE_KEY = "edgeever.imageCompressionEnabled";
const MEMO_LIST_DENSITY_STORAGE_KEY = "edgeever.memoListDensity";
const MEMO_LIST_WIDTH_STORAGE_KEY = "edgeever.memoListWidth";
const DEFAULT_MEMO_LIST_WIDTH_PX = 360;
const MIN_MEMO_LIST_WIDTH_PX = 300;
const MAX_MEMO_LIST_WIDTH_PX = 540;
const MEMO_SORT_OPTIONS: Array<{ value: MemoSortMode; label: string }> = [
  { value: "updated-desc", label: "最近更新" },
  { value: "created-desc", label: "创建时间" },
  { value: "title-asc", label: "标题 A-Z" },
];
const MEMO_FILTER_OPTIONS: Array<{ value: MemoFilterMode; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pinned", label: "置顶" },
  { value: "tagged", label: "有标签" },
  { value: "untagged", label: "无标签" },
];
const MEMO_TEMPLATES: MemoTemplate[] = [
  {
    id: "quick-note",
    title: "速记",
    description: "适合临时记录想法、链接和灵感。",
    contentMarkdown: "## 速记\n\n- \n\n## 后续动作\n\n- [ ] ",
    tags: ["template", "quick-note"],
  },
  {
    id: "meeting",
    title: "会议记录",
    description: "议题、结论和待办放在同一页。",
    contentMarkdown: "## 会议记录\n\n时间：\n参与人：\n\n## 议题\n\n- \n\n## 结论\n\n- \n\n## 待办\n\n- [ ] ",
    tags: ["template", "meeting"],
  },
  {
    id: "checklist",
    title: "清单",
    description: "快速列出待办、采购、项目检查项。",
    contentMarkdown: "## 清单\n\n- [ ] \n- [ ] \n- [ ] ",
    tags: ["template", "checklist"],
  },
  {
    id: "reading",
    title: "读书笔记",
    description: "摘录、观点和下一步阅读整理。",
    contentMarkdown: "## 读书笔记\n\n书名：\n作者：\n\n## 摘录\n\n> \n\n## 我的观点\n\n\n## 延伸问题\n\n- ",
    tags: ["template", "reading"],
  },
  {
    id: "daily",
    title: "每日复盘",
    description: "记录今天完成了什么、卡在哪里。",
    contentMarkdown: "## 每日复盘\n\n## 今天完成\n\n- \n\n## 遇到的问题\n\n- \n\n## 明天优先级\n\n- [ ] ",
    tags: ["template", "daily"],
  },
];
const MEMO_LONG_PRESS_DELAY_MS = 520;
const MEMO_LONG_PRESS_MOVE_TOLERANCE_PX = 14;

const getSelectionCountLabel = (count: number) => (count > 0 ? `已选择 ${count} 条` : "选择笔记");

const useDismissableLayer = <T extends HTMLElement>(open: boolean, onClose: () => void) => {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const node = ref.current;

      if (!node || node.contains(event.target as Node)) {
        return;
      }

      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  return ref;
};

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
  const [memoSelectionMode, setMemoSelectionMode] = useState(false);
  const [multiSelectKeyDown, setMultiSelectKeyDown] = useState(false);
  const [imageCompressionEnabled, setImageCompressionEnabled] = useState(readImageCompressionPreference);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [mobileNotebookPickerOpen, setMobileNotebookPickerOpen] = useState(false);
  const [mobileBottomNavActive, setMobileBottomNavActive] = useState<MobileBottomNavItem>("home");
  const [mobileSearchFocusToken, setMobileSearchFocusToken] = useState(0);
  const [memoListWidth, setMemoListWidth] = useState(readMemoListWidthPreference);
  const [search, setSearch] = useState("");
  const [syncSummary, setSyncSummary] = useState<SyncQueueSummary>(emptySyncQueueSummary);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [isSyncingQueuedChanges, setIsSyncingQueuedChanges] = useState(false);

  const runQueuedSync = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    setIsSyncingQueuedChanges(true);

    try {
      await syncQueuedChanges({
        onSynced: async (memo) => {
          queryClient.setQueryData(["memo", memo.id], { memo });
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["memos"] }),
            queryClient.invalidateQueries({ queryKey: ["memo", memo.id] }),
          ]);
        },
      });
    } finally {
      setIsSyncingQueuedChanges(false);
    }
  }, [queryClient]);

  const notebooksQuery = useQuery({
    queryKey: ["notebooks"],
    queryFn: () => api.listNotebooks(),
  });

  const notebooks = notebooksQuery.data?.notebooks ?? [];
  const defaultMemoNotebookId =
    selectedNotebookId ?? notebooks.find((notebook) => notebook.slug === "inbox")?.id ?? notebooks[0]?.id ?? null;
  const canCreateMemo = Boolean(defaultMemoNotebookId && memoView !== "trash");
  const memoSelectionModeActive = memoSelectionMode || selectedMemoIds.size > 0;

  const clearMemoSelection = useCallback(() => {
    setSelectedMemoIds(new Set());
    setMemoSelectionMode(false);
  }, []);

  const replaceMemoSelection = useCallback((memoIds: string[]) => {
    setSelectedMemoIds(new Set(memoIds));
    setMemoSelectionMode(true);
  }, []);

  const enterMemoSelectionMode = useCallback(() => {
    setMemoSelectionMode(true);
    setActivePane("memos");
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearMemoSelection();
        return;
      }

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
  }, [clearMemoSelection]);

  useEffect(() => {
    writeImageCompressionPreference(imageCompressionEnabled);
  }, [imageCompressionEnabled]);

  useEffect(() => observeSyncQueue(setSyncSummary), []);

  useEffect(() => {
    const updateOnlineState = () => {
      const online = navigator.onLine;
      setIsOnline(online);

      if (online) {
        void runQueuedSync();
      }
    };

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    updateOnlineState();

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, [runQueuedSync]);

  useEffect(() => {
    if (syncSummary.total === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      void runQueuedSync();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [runQueuedSync, syncSummary.total]);

  const memosQuery = useQuery({
    queryKey: ["memos", memoView, selectedNotebookId, search],
    queryFn: () =>
      api.listMemos({
        notebookId: memoView === "notebook" ? selectedNotebookId : null,
        q: search,
        trash: memoView === "trash",
      }),
  });

  const memos = memosQuery.data?.memos ?? [];
  const selectedMemoIndex = selectedMemoId ? memos.findIndex((memo) => memo.id === selectedMemoId) : -1;
  const previousMemoId = selectedMemoIndex > 0 ? memos[selectedMemoIndex - 1]?.id : null;
  const nextMemoId =
    selectedMemoIndex >= 0 && selectedMemoIndex < memos.length - 1 ? memos[selectedMemoIndex + 1]?.id : null;

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
    mutationFn: ({
      notebookId,
      payload,
    }: {
      notebookId: string;
      payload: { name?: string; parentId?: string | null; sortOrder?: number };
    }) => api.updateNotebook(notebookId, payload),
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
      clearMemoSelection();
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
      queryClient.setQueryData(["memo", data.memo.id], { memo: data.memo });
      setSelectedMemoId(data.memo.id);
      setActivePane("editor");
    },
  });

  const moveMemosMutation = useMutation({
    mutationFn: api.moveMemos,
    onSuccess: async () => {
      clearMemoSelection();
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
      await queryClient.invalidateQueries({ queryKey: ["memo"] });
    },
  });

  const deleteMemosMutation = useMutation({
    mutationFn: api.deleteMemos,
    onSuccess: async (_, variables) => {
      const deletedMemoIds = new Set(variables.memoIds);

      clearMemoSelection();

      if (selectedMemoId && deletedMemoIds.has(selectedMemoId)) {
        setSelectedMemoId(null);
        setActivePane("memos");
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["memos"] }),
        queryClient.invalidateQueries({ queryKey: ["memo"] }),
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
      ]);
    },
  });

  const deleteMemoMutation = useMutation({
    mutationFn: ({ memoId, permanent }: { memoId: string; permanent?: boolean }) =>
      api.deleteMemo(memoId, { permanent }),
    onSuccess: async (_data, variables) => {
      if (selectedMemoId === variables.memoId) {
        setSelectedMemoId(null);
        setActivePane("memos");
      }

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

    updateNotebookMutation.mutate({ notebookId: notebook.id, payload: { name: name.trim() } });
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

  const handleCreateMemo = (template?: MemoTemplate) => {
    if (!defaultMemoNotebookId || memoView === "trash") {
      return;
    }

    setTemplatesOpen(false);
    setMobileBottomNavActive("home");
    createMemoMutation.mutate({
      notebookId: defaultMemoNotebookId,
      title: template?.title ?? DEFAULT_MEMO_TITLE,
      contentMarkdown: template?.contentMarkdown ?? "",
      tags: template?.tags ?? [],
    });
  };

  const handleCreateChecklistMemo = () => {
    const checklistTemplate = MEMO_TEMPLATES.find((template) => template.id === "checklist");

    handleCreateMemo(checklistTemplate);
  };

  const handleMoveNotebook = (
    notebookId: string,
    targetNotebookId: string,
    position: NotebookDropPosition
  ) => {
    if (notebookId === targetNotebookId) {
      return;
    }

    const target = notebooks.find((notebook) => notebook.id === targetNotebookId);

    if (!target) {
      return;
    }

    updateNotebookMutation.mutate({
      notebookId,
      payload: {
        parentId: position === "inside" ? target.id : target.parentId,
        sortOrder: position === "inside" ? Date.now() : getNotebookDropSortOrder(notebooks, target, position),
      },
    });
  };

  const handleMoveSelectedMemos = (targetNotebookId: string) => {
    if (selectedMemoIds.size === 0 || memoView === "trash") {
      return;
    }

    moveMemosMutation.mutate({
      memoIds: Array.from(selectedMemoIds),
      notebookId: targetNotebookId,
    });
  };

  const handleMoveMemoFromList = (memoId: string, targetNotebookId: string) => {
    if (memoView === "trash") {
      return;
    }

    moveMemosMutation.mutate({
      memoIds: [memoId],
      notebookId: targetNotebookId,
    });
  };

  const handleMerge = () => {
    if (selectedMemoIds.size < 2 || memoView === "trash") {
      return;
    }

    mergeMutation.mutate({
      memoIds: Array.from(selectedMemoIds),
      notebookId: selectedNotebookId ?? undefined,
    });
  };

  const handleDeleteSelectedMemos = () => {
    if (selectedMemoIds.size === 0) {
      return;
    }

    const count = selectedMemoIds.size;
    const permanent = memoView === "trash";
    const confirmed = window.confirm(
      permanent
        ? `永久删除选中的 ${count} 条笔记？这个操作不可恢复。`
        : `删除选中的 ${count} 条笔记？删除后可在回收站恢复。`
    );

    if (!confirmed) {
      return;
    }

    deleteMemosMutation.mutate({
      memoIds: Array.from(selectedMemoIds),
      permanent,
    });
  };

  const handleDeleteMemoFromList = (memoId: string) => {
    const permanent = memoView === "trash";
    const confirmed = window.confirm(
      permanent ? "永久删除这条笔记？这个操作不可恢复。" : "删除这条笔记？删除后可在回收站恢复。"
    );

    if (!confirmed) {
      return;
    }

    deleteMemoMutation.mutate({ memoId, permanent });
  };

  const handleRestoreMemoFromList = (memoId: string) => {
    restoreMemoMutation.mutate(memoId);
  };

  const handleSelectNotebook = (notebookId: string) => {
    setMemoView("notebook");
    setSelectedNotebookId(notebookId);
    setMobileBottomNavActive("home");
    clearMemoSelection();
    setMobileNotebookPickerOpen(false);
    setActivePane("memos");
  };

  const handleSelectAllMemos = () => {
    setMemoView("notebook");
    setSelectedNotebookId(null);
    setMobileBottomNavActive("home");
    clearMemoSelection();
    setMobileNotebookPickerOpen(false);
    setActivePane("memos");
  };

  const handleMobileHome = () => {
    if (memoView === "trash") {
      setMemoView("notebook");
    }

    setMobileBottomNavActive("home");
    setSelectedNotebookId(null);
    clearMemoSelection();
    setActivePane("memos");
  };

  const handleMobileSearch = () => {
    setMobileBottomNavActive("search");
    setActivePane("memos");
    setMobileSearchFocusToken((value) => value + 1);
  };

  const handleOpenAssets = () => {
    setAssetsOpen(true);
  };

  const handleOpenTemplates = () => {
    setMobileBottomNavActive("templates");
    setTemplatesOpen(true);
  };

  const handleOpenSettings = () => {
    setMobileBottomNavActive("settings");
    setSettingsOpen(true);
  };

  const handleCloseAssets = () => {
    setAssetsOpen(false);
    setMobileBottomNavActive("home");
  };

  const handleCloseTemplates = () => {
    setTemplatesOpen(false);
    setMobileBottomNavActive("home");
  };

  const handleCloseSettings = () => {
    setSettingsOpen(false);
    setMobileBottomNavActive("home");
  };

  const handleMemoListResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = memoListWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampMemoListWidth(startWidth + moveEvent.clientX - startX);
      setMemoListWidth(nextWidth);
      writeMemoListWidthPreference(nextWidth);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-emerald-50 text-slate-950">
      <div className="min-w-0 flex-1">
        <main
          className="grid h-[100dvh] min-h-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[260px_var(--memo-list-width)_minmax(0,1fr)]"
          style={{ "--memo-list-width": `${memoListWidth}px` } as CSSProperties}
        >
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
              view={memoView}
              isLoading={notebooksQuery.isLoading}
              canCreateMemo={canCreateMemo}
              isCreatingMemo={createMemoMutation.isPending}
              onSelect={(notebookId) => {
                setMemoView("notebook");
                setSelectedNotebookId(notebookId);
                clearMemoSelection();
                setActivePane("memos");
              }}
              onCreateMemo={handleCreateMemo}
              onCreateNotebook={handleCreateNotebook}
              onRenameNotebook={handleRenameNotebook}
              onDeleteNotebook={handleDeleteNotebook}
              onMoveNotebook={handleMoveNotebook}
              onBackToList={() => {
                if (memoView === "trash") {
                  setMemoView("notebook");
                }

                setSelectedNotebookId(null);
                clearMemoSelection();
                setActivePane("memos");
              }}
              onLogout={onLogout}
              isLoggingOut={isLoggingOut}
              imageCompressionEnabled={imageCompressionEnabled}
              onImageCompressionChange={setImageCompressionEnabled}
              syncSummary={syncSummary}
              isOnline={isOnline}
              isSyncingQueuedChanges={isSyncingQueuedChanges}
              onSyncQueuedChanges={() => void runQueuedSync()}
              onOpenAssets={handleOpenAssets}
              onOpenTags={() => setTagsOpen(true)}
              onOpenSettings={handleOpenSettings}
              onOpenTrash={() => {
                setMemoView("trash");
                setSelectedNotebookId(null);
                setMobileBottomNavActive("home");
                clearMemoSelection();
                setSelectedMemoId(null);
                setActivePane("memos");
              }}
            />
          </aside>

          <section
            className={cn(
              "relative min-w-0 overflow-hidden border-r border-emerald-100 bg-emerald-50/80 lg:block",
              activePane === "memos" ? "block" : "hidden"
            )}
          >
            <MemoListPane
              notebook={selectedNotebook}
              notebooks={notebooks}
              user={user}
              view={memoView}
              memos={memos}
              selectedMemoId={selectedMemoId}
              selectedMemoIds={selectedMemoIds}
              selectionMode={memoSelectionModeActive}
              search={search}
              searchFocusToken={mobileSearchFocusToken}
              canCreateMemo={canCreateMemo}
              isLoading={memosQuery.isLoading}
              isCreating={createMemoMutation.isPending}
              isMerging={mergeMutation.isPending}
              isMoving={moveMemosMutation.isPending}
              isDeleting={deleteMemosMutation.isPending || deleteMemoMutation.isPending}
              isOnline={isOnline}
              isSyncingQueuedChanges={isSyncingQueuedChanges}
              multiSelectKeyDown={multiSelectKeyDown}
              onOpenNotebookPicker={() => setMobileNotebookPickerOpen(true)}
              onSearch={setSearch}
              onCreateChecklist={handleCreateChecklistMemo}
              onCreateMemo={handleCreateMemo}
              onClearSelection={clearMemoSelection}
              onEnterSelectionMode={enterMemoSelectionMode}
              onReplaceSelection={replaceMemoSelection}
              onOpenAssets={handleOpenAssets}
              onOpenTags={() => setTagsOpen(true)}
              onOpenTemplates={handleOpenTemplates}
              onOpenSettings={handleOpenSettings}
              onOpenTrash={() => {
                setMemoView("trash");
                setSelectedNotebookId(null);
                setMobileBottomNavActive("home");
                clearMemoSelection();
                setSelectedMemoId(null);
                setActivePane("memos");
              }}
              onOpenMemo={(memoId) => {
                setSelectedMemoId(memoId);
                setActivePane("editor");
              }}
              onToggleMemo={(memoId, rangeMemoIds) => {
                setMemoSelectionMode(true);
                setSelectedMemoIds((current) => {
                  if (!rangeMemoIds?.length) {
                    return toggleMemoSelection(current, memoId);
                  }

                  const next = new Set(current);

                  for (const rangeMemoId of rangeMemoIds) {
                    next.add(rangeMemoId);
                  }

                  return next;
                });
              }}
              onMerge={handleMerge}
              onDeleteMemo={handleDeleteMemoFromList}
              onRestoreMemo={handleRestoreMemoFromList}
              onMoveMemo={handleMoveMemoFromList}
              onDeleteSelectedMemos={handleDeleteSelectedMemos}
              onMoveSelectedMemos={handleMoveSelectedMemos}
              onSyncQueuedChanges={() => void runQueuedSync()}
            />
            <div
              className="absolute inset-y-0 right-[-3px] z-20 hidden w-1.5 cursor-col-resize transition hover:bg-emerald-300/70 lg:block"
              role="separator"
              aria-orientation="vertical"
              title="拖拽调整列表栏宽度"
              onPointerDown={handleMemoListResizePointerDown}
            />
          </section>

          <section className={cn("min-h-0 min-w-0 bg-white lg:block", activePane === "editor" ? "block" : "hidden")}>
            <EditorPane
              memo={selectedMemo}
              isTrashView={memoView === "trash"}
              notebooks={notebooks}
              isLoading={memoQuery.isLoading}
              imageCompressionEnabled={imageCompressionEnabled}
              hasNextMemo={Boolean(nextMemoId)}
              hasPreviousMemo={Boolean(previousMemoId)}
              onBackToList={() => setActivePane("memos")}
              onOpenNextMemo={() => {
                if (nextMemoId) {
                  setSelectedMemoId(nextMemoId);
                }
              }}
              onOpenPreviousMemo={() => {
                if (previousMemoId) {
                  setSelectedMemoId(previousMemoId);
                }
              }}
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
      {assetsOpen ? <AssetsDialog onClose={handleCloseAssets} /> : null}
      {tagsOpen ? <TagsDialog onClose={() => setTagsOpen(false)} /> : null}
      {settingsOpen ? <SettingsDialog onClose={handleCloseSettings} /> : null}
      {templatesOpen ? (
        <TemplatesDialog
          canCreateMemo={canCreateMemo}
          isCreating={createMemoMutation.isPending}
          onClose={handleCloseTemplates}
          onCreateMemo={handleCreateMemo}
        />
      ) : null}
      {activePane !== "editor" && !memoSelectionModeActive ? (
        <MobileBottomNav
          activeItem={mobileBottomNavActive}
          canCreateMemo={canCreateMemo && memoView !== "trash"}
          isCreating={createMemoMutation.isPending}
          onCreateMemo={handleCreateMemo}
          onHome={handleMobileHome}
          onOpenSettings={handleOpenSettings}
          onOpenTemplates={handleOpenTemplates}
          onSearch={handleMobileSearch}
        />
      ) : null}
      {mobileNotebookPickerOpen ? (
        <MobileNotebookPicker
          currentLabel={memoView === "trash" ? "回收站" : undefined}
          notebooks={notebooks}
          selectedNotebookId={selectedNotebookId}
          onClose={() => setMobileNotebookPickerOpen(false)}
          onSelectAll={handleSelectAllMemos}
          onSelect={handleSelectNotebook}
        />
      ) : null}
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

const readMemoListDensityPreference = (): MemoListDensity => {
  try {
    const density = window.localStorage.getItem(MEMO_LIST_DENSITY_STORAGE_KEY);
    return density === "compact" ? "compact" : "preview";
  } catch {
    return "preview";
  }
};

const writeMemoListDensityPreference = (density: MemoListDensity) => {
  try {
    window.localStorage.setItem(MEMO_LIST_DENSITY_STORAGE_KEY, density);
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
};

const clampMemoListWidth = (width: number) =>
  Math.min(MAX_MEMO_LIST_WIDTH_PX, Math.max(MIN_MEMO_LIST_WIDTH_PX, Math.round(width)));

const readMemoListWidthPreference = () => {
  try {
    const width = Number(window.localStorage.getItem(MEMO_LIST_WIDTH_STORAGE_KEY));
    return Number.isFinite(width) ? clampMemoListWidth(width) : DEFAULT_MEMO_LIST_WIDTH_PX;
  } catch {
    return DEFAULT_MEMO_LIST_WIDTH_PX;
  }
};

const writeMemoListWidthPreference = (width: number) => {
  try {
    window.localStorage.setItem(MEMO_LIST_WIDTH_STORAGE_KEY, String(clampMemoListWidth(width)));
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

const getNotebookDropPosition = (event: DragEvent<HTMLElement>): NotebookDropPosition => {
  const rect = event.currentTarget.getBoundingClientRect();
  const offset = event.clientY - rect.top;

  if (offset < rect.height * 0.28) {
    return "before";
  }

  if (offset > rect.height * 0.72) {
    return "after";
  }

  return "inside";
};

const getNotebookDropSortOrder = (
  notebooks: Notebook[],
  target: Notebook,
  position: Exclude<NotebookDropPosition, "inside">
) => {
  const siblings = notebooks
    .filter((notebook) => notebook.parentId === target.parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  const targetIndex = siblings.findIndex((notebook) => notebook.id === target.id);
  const insertionIndex = targetIndex < 0 ? siblings.length : position === "before" ? targetIndex : targetIndex + 1;
  const previous = siblings[insertionIndex - 1];
  const next = siblings[insertionIndex];

  if (!previous && !next) {
    return target.sortOrder + (position === "before" ? -1000 : 1000);
  }

  if (!previous) {
    return next.sortOrder - 1000;
  }

  if (!next) {
    return previous.sortOrder + 1000;
  }

  return Math.floor((previous.sortOrder + next.sortOrder) / 2);
};

const NotebookPane = ({
  authRequired,
  user,
  notebooks,
  selectedNotebookId,
  view,
  isLoading,
  canCreateMemo,
  isCreatingMemo,
  onSelect,
  onCreateMemo,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onMoveNotebook,
  onBackToList,
  onLogout,
  isLoggingOut,
  imageCompressionEnabled,
  onImageCompressionChange,
  syncSummary,
  isOnline,
  isSyncingQueuedChanges,
  onSyncQueuedChanges,
  onOpenAssets,
  onOpenTags,
  onOpenSettings,
  onOpenTrash,
}: {
  authRequired: boolean;
  user: AuthUser | null;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  view: MemoView;
  isLoading: boolean;
  canCreateMemo: boolean;
  isCreatingMemo: boolean;
  onSelect: (notebookId: string) => void;
  onCreateMemo: () => void;
  onCreateNotebook: (parentId?: string | null) => void;
  onRenameNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onMoveNotebook: (notebookId: string, targetNotebookId: string, position: NotebookDropPosition) => void;
  onBackToList: () => void;
  onLogout: () => void;
  isLoggingOut: boolean;
  imageCompressionEnabled: boolean;
  onImageCompressionChange: (enabled: boolean) => void;
  syncSummary: SyncQueueSummary;
  isOnline: boolean;
  isSyncingQueuedChanges: boolean;
  onSyncQueuedChanges: () => void;
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
          <div className="text-xs text-slate-500">{user?.username ?? "边缘笔记工作区"}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button className="lg:hidden" size="icon" variant="ghost" title="返回笔记列表" onClick={onBackToList}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="新建笔记本" onClick={() => onCreateNotebook(null)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-4 hidden overflow-hidden rounded-full border border-emerald-100 bg-white shadow-[0_10px_28px_rgba(15,23,42,0.08)] lg:flex">
          <button
            className="flex h-14 min-w-0 flex-1 items-center gap-3 px-3 text-left transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            title="新建笔记"
            onClick={onCreateMemo}
            disabled={!canCreateMemo || isCreatingMemo}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-[0_8px_18px_rgba(5,150,105,0.28)]">
              <Plus className="h-6 w-6" />
            </span>
            <span className="min-w-0 truncate text-sm font-semibold text-slate-950">新建笔记</span>
          </button>
        </div>

        <nav className="mb-4 space-y-1">
          <SidebarNavButton
            active={view === "notebook" && selectedNotebookId === null}
            icon={<LayoutList className="h-4 w-4" />}
            label="全部笔记"
            onClick={onBackToList}
          />
          <SidebarNavButton icon={<Tags className="h-4 w-4" />} label="标签" onClick={onOpenTags} />
          <SidebarNavButton icon={<Archive className="h-4 w-4" />} label="附件" onClick={onOpenAssets} />
          <SidebarNavButton
            active={view === "trash"}
            icon={<Trash2 className="h-4 w-4" />}
            label="回收站"
            onClick={onOpenTrash}
          />
          <SidebarNavButton icon={<UserRound className="h-4 w-4" />} label="我的" onClick={onOpenSettings} />
        </nav>

        <div className="mb-3 flex items-center justify-between gap-2 px-2 text-xs font-semibold uppercase text-slate-500">
          <span className="inline-flex min-w-0 items-center gap-2">
            <Folder className="h-4 w-4" />
            笔记本
          </span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-800 lg:hidden"
            type="button"
            title="新建笔记本"
            onClick={() => onCreateNotebook(null)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
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
                onMoveNotebook={onMoveNotebook}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-emerald-100 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <SyncStatusBar
          summary={syncSummary}
          isOnline={isOnline}
          isSyncing={isSyncingQueuedChanges}
          onSyncNow={onSyncQueuedChanges}
        />
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
        {authRequired ? (
          <Button className="w-full justify-center" size="md" variant="ghost" onClick={onLogout} disabled={isLoggingOut}>
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        ) : null}
      </footer>
    </div>
  );
};

const SyncStatusBar = ({
  summary,
  isOnline,
  isSyncing,
  onSyncNow,
}: {
  summary: SyncQueueSummary;
  isOnline: boolean;
  isSyncing: boolean;
  onSyncNow: () => void;
}) => {
  const hasQueuedWork = summary.total > 0;
  const label = getSyncStatusLabel(summary, isOnline, isSyncing);
  const statusClassName = !isOnline
    ? "border-slate-200 bg-slate-50 text-slate-600"
    : summary.conflict > 0
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : hasQueuedWork
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-emerald-100 bg-white text-slate-500";

  return (
    <div className={cn("mb-3 flex min-h-10 items-center gap-2 rounded-md border px-3 py-2", statusClassName)}>
      {!isOnline ? (
        <CloudOff className="h-4 w-4 shrink-0" />
      ) : summary.conflict > 0 ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : hasQueuedWork || isSyncing ? (
        <RefreshCw className={cn("h-4 w-4 shrink-0", isSyncing && "animate-spin")} />
      ) : (
        <CheckCircle2 className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
      {hasQueuedWork ? (
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-white/70 disabled:opacity-50"
          type="button"
          title="立即同步"
          disabled={!isOnline || isSyncing}
          onClick={onSyncNow}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
};

const SidebarNavButton = ({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button
    className={cn(
      "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition",
      active ? "bg-emerald-100 text-emerald-950" : "text-slate-700 hover:bg-emerald-50 hover:text-emerald-900"
    )}
    type="button"
    onClick={onClick}
  >
    <span className="shrink-0">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
);

const getSyncStatusLabel = (summary: SyncQueueSummary, isOnline: boolean, isSyncing: boolean) => {
  if (!isOnline) {
    return summary.total > 0 ? `离线，${summary.total} 项待同步` : "离线";
  }

  if (isSyncing || summary.syncing > 0) {
    return "同步中";
  }

  if (summary.conflict > 0) {
    return `${summary.conflict} 项同步冲突`;
  }

  if (summary.error > 0) {
    return `${summary.error} 项等待重试`;
  }

  if (summary.pending > 0) {
    return `${summary.pending} 项待同步`;
  }

  return "已同步";
};

const MobileBottomNav = ({
  activeItem,
  canCreateMemo,
  isCreating,
  onCreateMemo,
  onHome,
  onOpenSettings,
  onOpenTemplates,
  onSearch,
}: {
  activeItem: MobileBottomNavItem;
  canCreateMemo: boolean;
  isCreating: boolean;
  onCreateMemo: () => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onOpenTemplates: () => void;
  onSearch: () => void;
}) => (
  <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-emerald-100 bg-white/95 px-5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden">
    <div className="relative grid h-16 grid-cols-5 items-center">
      <MobileBottomNavButton active={activeItem === "home"} icon={<Home className="h-5 w-5" />} label="首页" onClick={onHome} />
      <MobileBottomNavButton active={activeItem === "search"} icon={<Search className="h-5 w-5" />} label="搜索" onClick={onSearch} />
      <div aria-hidden="true" />
      <MobileBottomNavButton
        active={activeItem === "templates"}
        icon={<LayoutList className="h-5 w-5" />}
        label="模板"
        onClick={onOpenTemplates}
      />
      <MobileBottomNavButton active={activeItem === "settings"} icon={<UserRound className="h-5 w-5" />} label="我的" onClick={onOpenSettings} />
      <button
        className="absolute left-1/2 top-[-1.35rem] flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full border-[6px] border-white bg-emerald-600 text-white shadow-[0_12px_26px_rgba(5,150,105,0.32)] transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-300 disabled:opacity-70 disabled:hover:bg-emerald-300"
        type="button"
        title={!canCreateMemo ? "当前视图不可新建笔记" : isCreating ? "正在创建" : "新建笔记"}
        disabled={!canCreateMemo || isCreating}
        onClick={onCreateMemo}
      >
        <Plus className="h-8 w-8" />
      </button>
    </div>
  </nav>
);

const MobileBottomNavButton = ({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button
    className={cn(
      "flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs font-medium transition",
      active ? "text-emerald-600" : "text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
    )}
    type="button"
    onClick={onClick}
  >
    {icon}
    <span>{label}</span>
  </button>
);

const MobileSheetGrabber = () => (
  <div className="flex justify-center py-2 sm:hidden">
    <div className="h-1 w-10 rounded-full bg-slate-300" />
  </div>
);

const MobileHomeHeader = ({
  isOnline,
  isSyncingQueuedChanges,
  user,
  onSyncQueuedChanges,
}: {
  isOnline: boolean;
  isSyncingQueuedChanges: boolean;
  user: AuthUser | null;
  onSyncQueuedChanges: () => void;
}) => {
  const displayName = user?.displayName?.trim() || user?.username?.trim() || "EdgeEver";
  const initial = displayName.charAt(0).toLocaleUpperCase("zh-CN") || "E";

  return (
    <div className="mb-4 flex h-12 items-center justify-between gap-3 lg:hidden">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800 shadow-[0_8px_18px_rgba(5,150,105,0.16)]">
          {initial}
        </div>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-950">Hi {displayName}</div>
          <div className="truncate text-xs text-slate-500">{isOnline ? "已连接 EdgeEver" : "离线模式"}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full transition",
            isOnline ? "text-slate-600 hover:bg-emerald-50 hover:text-emerald-700" : "bg-amber-50 text-amber-700"
          )}
          type="button"
          title={isOnline ? "同步" : "离线"}
          aria-label={isOnline ? "同步" : "离线"}
          disabled={!isOnline || isSyncingQueuedChanges}
          onClick={onSyncQueuedChanges}
        >
          {isOnline ? (
            <RefreshCw className={cn("h-5 w-5", isSyncingQueuedChanges && "animate-spin")} />
          ) : (
            <CloudOff className="h-5 w-5" />
          )}
        </button>
      </div>
    </div>
  );
};

const MobileQuickActions = ({
  canCreateMemo,
  isCreating,
  locked = false,
  onCreateChecklist,
  onCreateMemo,
  onOpenAssets,
  onOpenTags,
  onOpenTemplates,
}: {
  canCreateMemo: boolean;
  isCreating: boolean;
  locked?: boolean;
  onCreateChecklist: () => void;
  onCreateMemo: () => void;
  onOpenAssets: () => void;
  onOpenTags: () => void;
  onOpenTemplates: () => void;
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activePage, setActivePage] = useState(0);
  const actions = [
    {
      disabled: !canCreateMemo || isCreating,
      icon: <FilePlus2 className="h-5 w-5" />,
      label: "笔记",
      onClick: onCreateMemo,
    },
    {
      disabled: !canCreateMemo || isCreating,
      icon: <CheckSquare className="h-5 w-5" />,
      label: "清单",
      onClick: onCreateChecklist,
    },
    {
      disabled: !canCreateMemo || isCreating,
      icon: <LayoutList className="h-5 w-5" />,
      label: "模板",
      onClick: onOpenTemplates,
    },
    { icon: <Tags className="h-5 w-5" />, label: "标签", onClick: onOpenTags },
    { icon: <Archive className="h-5 w-5" />, label: "附件", onClick: onOpenAssets },
  ];
  const handleScroll = () => {
    const node = scrollRef.current;

    if (!node) {
      return;
    }

    const scrollableWidth = node.scrollWidth - node.clientWidth;

    if (scrollableWidth <= 0) {
      setActivePage(0);
      return;
    }

    setActivePage(node.scrollLeft > scrollableWidth / 2 ? 1 : 0);
  };

  return (
    <div className="mb-4 lg:hidden">
      <div
        ref={scrollRef}
        className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={handleScroll}
      >
        {actions.map((action) => (
          <MobileQuickActionButton
            key={action.label}
            disabled={action.disabled}
            icon={action.icon}
            label={action.label}
            locked={locked}
            onClick={action.onClick}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-center gap-1.5" aria-hidden="true">
        <span className={cn("h-1.5 rounded-full transition-all", activePage === 0 ? "w-4 bg-emerald-500" : "w-1.5 bg-slate-300")} />
        <span className={cn("h-1.5 rounded-full transition-all", activePage === 1 ? "w-4 bg-emerald-500" : "w-1.5 bg-slate-300")} />
      </div>
    </div>
  );
};

const MobileQuickActionButton = ({
  disabled = false,
  icon,
  label,
  locked = false,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  locked?: boolean;
  onClick: () => void;
}) => (
  <button
    className={cn(
      "flex h-[76px] w-[92px] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-md border border-slate-100 bg-white text-xs font-medium text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition disabled:cursor-not-allowed disabled:opacity-40",
      locked ? "cursor-default" : "hover:bg-slate-50"
    )}
    type="button"
    disabled={disabled}
    aria-disabled={locked || disabled}
    tabIndex={locked ? -1 : undefined}
    onClick={(event) => {
      if (locked) {
        event.preventDefault();
        return;
      }

      onClick();
    }}
  >
    <span className="text-slate-700">{icon}</span>
    <span className="max-w-full truncate px-1">{label}</span>
  </button>
);

const MobileNotebookPicker = ({
  currentLabel,
  notebooks,
  selectedNotebookId,
  onClose,
  onSelectAll,
  onSelect,
}: {
  currentLabel?: string;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  onClose: () => void;
  onSelectAll: () => void;
  onSelect: (notebookId: string) => void;
}) => {
  const [notebookSearch, setNotebookSearch] = useState("");
  const tree = useMemo(() => buildNotebookTree(notebooks), [notebooks]);
  const filteredTree = useMemo(() => filterNotebookTree(tree, notebookSearch), [notebookSearch, tree]);
  const allSelected = !currentLabel && selectedNotebookId === null;
  const selectedNotebookName =
    currentLabel ?? (allSelected ? "全部笔记" : notebooks.find((item) => item.id === selectedNotebookId)?.name ?? "笔记本");
  const searchQuery = notebookSearch.trim();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/30 lg:hidden" onClick={onClose}>
      <section
        className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-hidden rounded-t-md border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(15,23,42,0.16)]"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
        <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
          <div className="min-w-0">
            <div className="text-base font-semibold text-slate-950">切换笔记本</div>
            <div className="truncate text-xs text-slate-500">当前：{selectedNotebookName}</div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="border-b border-slate-100 px-4 py-2">
          <div className="flex h-9 items-center gap-2 rounded-md bg-slate-100 px-3 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <input
              className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
              value={notebookSearch}
              placeholder="搜索笔记本"
              onChange={(event) => setNotebookSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && notebookSearch) {
                  event.preventDefault();
                  setNotebookSearch("");
                }
              }}
            />
            {notebookSearch ? (
              <button
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700"
                type="button"
                title="清空搜索"
                aria-label="清空搜索"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setNotebookSearch("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="max-h-[calc(82dvh_-_8.25rem_-_env(safe-area-inset-bottom))] overflow-y-auto p-2">
          <button
            className={cn(
              "mb-1 flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition",
              allSelected ? "bg-emerald-50 font-semibold text-emerald-950" : "text-slate-800 hover:bg-slate-50"
            )}
            type="button"
            aria-current={allSelected ? "page" : undefined}
            onClick={onSelectAll}
          >
            <LayoutList className={cn("h-5 w-5 shrink-0", allSelected ? "text-emerald-700" : "text-slate-600")} />
            <span className="min-w-0 flex-1 truncate text-base">全部笔记</span>
            {allSelected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
          </button>
          {filteredTree.length > 0 ? (
            filteredTree.map((node) => (
              <MobileNotebookPickerItem
                key={node.id}
                node={node}
                depth={0}
                selectedNotebookId={selectedNotebookId}
                onSelect={onSelect}
              />
            ))
          ) : (
            <div className="px-3 py-8 text-center">
              <div className="text-sm font-medium text-slate-700">
                {searchQuery ? `没有找到「${searchQuery}」` : "没有找到笔记本"}
              </div>
              {searchQuery ? (
                <button
                  className="mt-3 text-sm font-semibold text-emerald-700"
                  type="button"
                  onClick={() => setNotebookSearch("")}
                >
                  显示全部笔记本
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

const MobileNotebookPickerItem = ({
  node,
  depth,
  selectedNotebookId,
  onSelect,
}: {
  node: NotebookNode;
  depth: number;
  selectedNotebookId: string | null;
  onSelect: (notebookId: string) => void;
}) => {
  const selected = node.id === selectedNotebookId;

  return (
    <div>
      <button
        className={cn(
          "flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition",
          selected ? "bg-emerald-50 font-semibold text-emerald-950" : "text-slate-800 hover:bg-slate-50"
        )}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(node.id)}
      >
        {node.slug === "inbox" ? (
          <Inbox className={cn("h-5 w-5 shrink-0", selected ? "text-emerald-700" : "text-slate-600")} />
        ) : (
          <Folder className={cn("h-5 w-5 shrink-0", selected ? "text-emerald-700" : "text-slate-600")} />
        )}
        <span className="min-w-0 flex-1 truncate text-base">{node.name}</span>
        {selected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
      </button>
      {node.children.length > 0 ? (
        <div className="mt-1 border-l border-slate-100 pl-1">
          {node.children.map((child) => (
            <MobileNotebookPickerItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNotebookId={selectedNotebookId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const filterNotebookTree = (nodes: NotebookNode[], search: string): NotebookNode[] => {
  const query = search.trim().toLocaleLowerCase("zh-CN");

  if (!query) {
    return nodes;
  }

  const walk = (items: NotebookNode[]): NotebookNode[] => {
    const filteredNodes: NotebookNode[] = [];

    for (const node of items) {
      const children = walk(node.children);
      const matched = node.name.toLocaleLowerCase("zh-CN").includes(query);

      if (matched) {
        filteredNodes.push({ ...node, children: node.children });
        continue;
      }

      if (children.length > 0) {
        filteredNodes.push({ ...node, children });
      }
    }

    return filteredNodes;
  };

  return walk(nodes);
};

const mobileSortOptions: Array<{ value: MemoSortMode; label: string }> = [
  { value: "updated-desc", label: "最近更新" },
  { value: "created-desc", label: "创建时间" },
  { value: "title-asc", label: "标题 A-Z" },
];
const memoListDensityOptions: Array<{ value: MemoListDensity; label: string; icon: ReactNode }> = [
  { value: "preview", label: "卡片预览", icon: <LayoutList className="h-4 w-4" /> },
  { value: "compact", label: "紧凑列表", icon: <List className="h-4 w-4" /> },
];

const MobileListActionsSheet = ({
  canSelectMemos,
  isSelectionMode,
  listDensity,
  sortMode,
  onClose,
  onEnterSelectionMode,
  onOpenAssets,
  onOpenSettings,
  onOpenTags,
  onOpenTrash,
  onListDensityChange,
  onSortModeChange,
}: {
  canSelectMemos: boolean;
  isSelectionMode: boolean;
  listDensity: MemoListDensity;
  sortMode: MemoSortMode;
  onClose: () => void;
  onEnterSelectionMode: () => void;
  onOpenAssets: () => void;
  onOpenSettings: () => void;
  onOpenTags: () => void;
  onOpenTrash: () => void;
  onListDensityChange: (value: MemoListDensity) => void;
  onSortModeChange: (value: MemoSortMode) => void;
}) => (
  <div className="fixed inset-0 z-50 bg-slate-950/25 px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] lg:hidden" onClick={onClose}>
    <section
      className="absolute inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_6.75rem_-_env(safe-area-inset-bottom))] overflow-hidden rounded-md border border-slate-200 bg-white shadow-panel"
      onClick={(event) => event.stopPropagation()}
    >
      <MobileSheetGrabber />
      <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
        <div className="text-sm font-semibold text-slate-950">列表选项</div>
        <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="max-h-[calc(100dvh_-_10.25rem_-_env(safe-area-inset-bottom))] overflow-y-auto p-2">
        {!isSelectionMode ? (
          <>
            <MobileListActionButton
              disabled={!canSelectMemos}
              icon={<CheckSquare className="h-4 w-4" />}
              label="选择笔记"
              onClick={onEnterSelectionMode}
            />

            <div className="my-2 h-px bg-slate-100" />
          </>
        ) : null}

        <div className="px-3 py-2 text-xs font-semibold text-slate-400">显示方式</div>
        {memoListDensityOptions.map((option) => (
          <button
            key={option.value}
            className={cn(
              "flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition",
              listDensity === option.value ? "bg-emerald-50 text-emerald-950" : "text-slate-800 hover:bg-slate-50"
            )}
            type="button"
            aria-pressed={listDensity === option.value}
            onClick={() => onListDensityChange(option.value)}
          >
            <span className={listDensity === option.value ? "text-emerald-700" : "text-slate-500"}>{option.icon}</span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <CheckCircle2 className={cn("h-4 w-4 shrink-0", listDensity === option.value ? "text-emerald-600" : "text-transparent")} />
          </button>
        ))}

        <div className="my-2 h-px bg-slate-100" />

        <div className="px-3 py-2 text-xs font-semibold text-slate-400">排序方式</div>
        {mobileSortOptions.map((option) => (
          <button
            key={option.value}
            className={cn(
              "flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition",
              sortMode === option.value ? "bg-emerald-50 text-emerald-950" : "text-slate-800 hover:bg-slate-50"
            )}
            type="button"
            aria-pressed={sortMode === option.value}
            onClick={() => onSortModeChange(option.value)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <CheckCircle2 className={cn("h-4 w-4 shrink-0", sortMode === option.value ? "text-emerald-600" : "text-transparent")} />
          </button>
        ))}

        <div className="my-2 h-px bg-slate-100" />

        <MobileListActionButton icon={<Tags className="h-4 w-4" />} label="标签" onClick={onOpenTags} />
        <MobileListActionButton icon={<Archive className="h-4 w-4" />} label="附件" onClick={onOpenAssets} />
        <MobileListActionButton icon={<Trash2 className="h-4 w-4" />} label="回收站" onClick={onOpenTrash} />
        <MobileListActionButton icon={<UserRound className="h-4 w-4" />} label="我的" onClick={onOpenSettings} />
      </div>
    </section>
  </div>
);

const MobileListActionButton = ({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button
    className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:opacity-40"
    type="button"
    disabled={disabled}
    onClick={onClick}
  >
    <span className="text-slate-500">{icon}</span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
);

const MobileSelectionActionBar = ({
  canDelete,
  canMove,
  deleteTitle,
  isTrashView,
  moveTitle,
  onDelete,
  onOpenMore,
  onOpenMove,
}: {
  canDelete: boolean;
  canMove: boolean;
  deleteTitle: string;
  isTrashView: boolean;
  moveTitle: string;
  onDelete: () => void;
  onOpenMore: () => void;
  onOpenMove: () => void;
}) => (
  <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-8 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden">
    <div className="grid h-14 grid-cols-3 items-center">
      <MobileSelectionActionButton
        disabled={!canMove}
        icon={<Folder className="h-5 w-5" />}
        label="移动"
        title={moveTitle}
        onClick={onOpenMove}
      />
      <MobileSelectionActionButton
        disabled={!canDelete}
        icon={<Trash2 className="h-5 w-5" />}
        label={isTrashView ? "永久删除" : "删除"}
        title={deleteTitle}
        onClick={onDelete}
      />
      <MobileSelectionActionButton icon={<MoreVertical className="h-5 w-5" />} label="更多" onClick={onOpenMore} />
    </div>
  </nav>
);

const MobileSelectionActionButton = ({
  disabled = false,
  icon,
  label,
  title = label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}) => (
  <button
    className="flex h-12 flex-col items-center justify-center gap-1 rounded-md text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300 disabled:opacity-100 disabled:hover:bg-transparent"
    type="button"
    disabled={disabled}
    title={title}
    aria-label={title}
    onClick={onClick}
  >
    {icon}
    <span>{label}</span>
  </button>
);

const MobileMoveSheet = ({
  isMoving,
  notebooks,
  selectedCount,
  selectedNotebookId,
  onClose,
  onMove,
}: {
  isMoving: boolean;
  notebooks: Notebook[];
  selectedCount: number;
  selectedNotebookId: string;
  onClose: () => void;
  onMove: (notebookId: string) => void;
}) => {
  const [notebookSearch, setNotebookSearch] = useState("");
  const options = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const selectedCountLabel = getSelectionCountLabel(selectedCount);
  const moveSearchQuery = notebookSearch.trim().toLocaleLowerCase("zh-CN");
  const filteredOptions = useMemo(() => {
    if (!moveSearchQuery) {
      return options;
    }

    return options.filter((option) =>
      [option.name, option.selectLabel, option.slug ?? ""].some((value) => value.toLocaleLowerCase("zh-CN").includes(moveSearchQuery))
    );
  }, [moveSearchQuery, options]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/25 px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] lg:hidden" onClick={onClose}>
      <section
        className="absolute inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_6.75rem_-_env(safe-area-inset-bottom))] overflow-hidden rounded-md border border-slate-200 bg-white shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
        <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-950">移动到笔记本</div>
            <div className="truncate text-xs text-slate-500">{selectedCountLabel}</div>
          </div>
          <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="border-b border-slate-100 px-3 py-2">
          <div className="flex h-9 items-center gap-2 rounded-md bg-slate-100 px-3 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <input
              className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
              value={notebookSearch}
              placeholder="搜索笔记本"
              onChange={(event) => setNotebookSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && notebookSearch) {
                  event.preventDefault();
                  setNotebookSearch("");
                }
              }}
            />
            {notebookSearch ? (
              <button
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700"
                type="button"
                title="清空搜索"
                aria-label="清空搜索"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setNotebookSearch("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="max-h-[calc(100dvh_-_13.75rem_-_env(safe-area-inset-bottom))] overflow-y-auto p-2">
          {filteredOptions.length > 0 ? filteredOptions.map((option) => (
            <button
              key={option.id}
              className={cn(
                "flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition",
                option.id === selectedNotebookId ? "bg-emerald-100 font-semibold text-emerald-950" : "text-slate-700 hover:bg-slate-50"
              )}
              style={{ paddingLeft: `${12 + option.depth * 18}px` }}
              type="button"
              disabled={isMoving}
              onClick={() => onMove(option.id)}
            >
              {option.slug === "inbox" ? <Inbox className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.id === selectedNotebookId ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
            </button>
          )) : (
            <div className="px-3 py-8 text-center text-sm font-medium text-slate-500">没有找到笔记本</div>
          )}
        </div>
      </section>
    </div>
  );
};

const MobileNotebookSelectSheet = ({
  isUpdating,
  options,
  selectedNotebookId,
  onClose,
  onSelect,
}: {
  isUpdating: boolean;
  options: NotebookMoveOption[];
  selectedNotebookId: string;
  onClose: () => void;
  onSelect: (notebookId: string) => void;
}) => (
  <div className="fixed inset-0 z-50 bg-slate-950/25 lg:hidden" onClick={onClose}>
    <section
      className="absolute inset-x-0 bottom-0 max-h-[62dvh] overflow-hidden rounded-t-md border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(15,23,42,0.16)]"
      onClick={(event) => event.stopPropagation()}
    >
      <MobileSheetGrabber />
      <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
        <div className="text-base font-semibold text-slate-950">所在笔记本</div>
        <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="max-h-[calc(62dvh-3.75rem-env(safe-area-inset-bottom))] overflow-y-auto p-2">
        {options.map((option) => {
          const selected = option.id === selectedNotebookId;

          return (
            <button
              key={option.id}
              className={cn(
                "flex h-12 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition",
                selected ? "bg-emerald-100 font-semibold text-emerald-950" : "text-slate-700 hover:bg-slate-50"
              )}
              style={{ paddingLeft: `${12 + option.depth * 18}px` }}
              type="button"
              disabled={isUpdating}
              onClick={() => onSelect(option.id)}
            >
              {option.slug === "inbox" ? <Inbox className="h-5 w-5 shrink-0" /> : <Folder className="h-5 w-5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-base">{option.name}</span>
              {selected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  </div>
);

const MobileSelectionMoreSheet = ({
  canMerge,
  canToggleVisibleSelection,
  mergeTitle,
  selectedCount,
  selectionToggleLabel,
  selectionToggleTitle,
  onClearSelection,
  onClose,
  onMerge,
  onToggleVisibleSelection,
}: {
  canMerge: boolean;
  canToggleVisibleSelection: boolean;
  mergeTitle: string;
  selectedCount: number;
  selectionToggleLabel: string;
  selectionToggleTitle: string;
  onClearSelection: () => void;
  onClose: () => void;
  onMerge: () => void;
  onToggleVisibleSelection: () => void;
}) => (
  <div className="fixed inset-0 z-50 bg-slate-950/25 px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] lg:hidden" onClick={onClose}>
    <section
      className="absolute inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh_-_6.75rem_-_env(safe-area-inset-bottom))] overflow-hidden rounded-md border border-slate-200 bg-white shadow-panel"
      onClick={(event) => event.stopPropagation()}
    >
      <MobileSheetGrabber />
      <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-950">批量操作</div>
          <div className="truncate text-xs text-slate-500">{getSelectionCountLabel(selectedCount)}</div>
        </div>
        <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      <button
        className="flex h-12 w-full items-center gap-3 border-b border-slate-100 px-4 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:opacity-100 disabled:hover:bg-transparent"
        type="button"
        disabled={!canToggleVisibleSelection}
        title={selectionToggleTitle}
        onClick={onToggleVisibleSelection}
      >
        <CheckSquare className="h-4 w-4" />
        {selectionToggleLabel}
      </button>
      <button
        className="flex h-12 w-full items-center gap-3 border-b border-slate-100 px-4 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:opacity-100 disabled:hover:bg-transparent"
        type="button"
        disabled={!canMerge}
        title={mergeTitle}
        onClick={onMerge}
      >
        <Merge className="h-4 w-4" />
        合并笔记
      </button>
      <button
        className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50"
        type="button"
        title="取消选择"
        aria-label="取消选择"
        onClick={onClearSelection}
      >
        <X className="h-4 w-4" />
        取消选择
      </button>
    </section>
  </div>
);

const NotebookTreeItem = ({
  node,
  depth,
  selectedNotebookId,
  onSelect,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onMoveNotebook,
}: {
  node: NotebookNode;
  depth: number;
  selectedNotebookId: string | null;
  onSelect: (notebookId: string) => void;
  onCreateNotebook: (parentId?: string | null) => void;
  onRenameNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onMoveNotebook: (notebookId: string, targetNotebookId: string, position: NotebookDropPosition) => void;
}) => {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const selected = node.id === selectedNotebookId;
  const isInbox = node.slug === "inbox";
  const [dropPosition, setDropPosition] = useState<NotebookDropPosition | null>(null);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropPosition(getNotebookDropPosition(event));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const notebookId = event.dataTransfer.getData("application/x-edgeever-notebook");
    const position = getNotebookDropPosition(event);
    setDropPosition(null);

    if (!notebookId || notebookId === node.id) {
      return;
    }

    onMoveNotebook(notebookId, node.id, position);
    setOpen(true);
  };

  return (
    <div>
      <div
        className={cn(
          "group flex h-9 items-center gap-1 rounded-md px-2 text-sm transition",
          selected ? "border border-emerald-200 bg-emerald-100 text-emerald-950" : "text-slate-700 hover:bg-emerald-50",
          dropPosition === "inside" && "ring-2 ring-emerald-300",
          dropPosition === "before" && "shadow-[inset_0_2px_0_0_#627f58]",
          dropPosition === "after" && "shadow-[inset_0_-2px_0_0_#627f58]"
        )}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-edgeever-notebook", node.id);
          event.dataTransfer.setData("text/plain", node.id);
        }}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropPosition(null)}
        onDrop={handleDrop}
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
              onMoveNotebook={onMoveNotebook}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const MemoListPane = ({
  notebook,
  notebooks,
  user,
  view,
  memos,
  selectedMemoId,
  selectedMemoIds,
  selectionMode,
  search,
  searchFocusToken,
  canCreateMemo,
  isLoading,
  isCreating,
  isMerging,
  isMoving,
  isDeleting,
  isOnline,
  isSyncingQueuedChanges,
  multiSelectKeyDown,
  onOpenNotebookPicker,
  onSearch,
  onCreateChecklist,
  onCreateMemo,
  onClearSelection,
  onEnterSelectionMode,
  onReplaceSelection,
  onOpenAssets,
  onOpenMemo,
  onToggleMemo,
  onOpenSettings,
  onOpenTags,
  onOpenTemplates,
  onOpenTrash,
  onMerge,
  onDeleteMemo,
  onRestoreMemo,
  onMoveMemo,
  onDeleteSelectedMemos,
  onMoveSelectedMemos,
  onSyncQueuedChanges,
}: {
  notebook: Notebook | null;
  notebooks: Notebook[];
  user: AuthUser | null;
  view: MemoView;
  memos: MemoSummary[];
  selectedMemoId: string | null;
  selectedMemoIds: Set<string>;
  selectionMode: boolean;
  search: string;
  searchFocusToken: number;
  canCreateMemo: boolean;
  isLoading: boolean;
  isCreating: boolean;
  isMerging: boolean;
  isMoving: boolean;
  isDeleting: boolean;
  isOnline: boolean;
  isSyncingQueuedChanges: boolean;
  multiSelectKeyDown: boolean;
  onOpenNotebookPicker: () => void;
  onSearch: (value: string) => void;
  onCreateChecklist: () => void;
  onCreateMemo: () => void;
  onClearSelection: () => void;
  onEnterSelectionMode: () => void;
  onReplaceSelection: (memoIds: string[]) => void;
  onOpenAssets: () => void;
  onOpenMemo: (memoId: string) => void;
  onToggleMemo: (memoId: string, rangeMemoIds?: string[]) => void;
  onOpenSettings: () => void;
  onOpenTags: () => void;
  onOpenTemplates: () => void;
  onOpenTrash: () => void;
  onMerge: () => void;
  onDeleteMemo: (memoId: string) => void;
  onRestoreMemo: (memoId: string) => void;
  onMoveMemo: (memoId: string, targetNotebookId: string) => void;
  onDeleteSelectedMemos: () => void;
  onMoveSelectedMemos: (notebookId: string) => void;
  onSyncQueuedChanges: () => void;
}) => {
  const [moveTargetNotebookId, setMoveTargetNotebookId] = useState(notebook?.id ?? notebooks[0]?.id ?? "");
  const [desktopFilterOpen, setDesktopFilterOpen] = useState(false);
  const [desktopSortOpen, setDesktopSortOpen] = useState(false);
  const [desktopActionsOpen, setDesktopActionsOpen] = useState(false);
  const [mobileListActionsOpen, setMobileListActionsOpen] = useState(false);
  const [mobileMoveOpen, setMobileMoveOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [memoContextMenu, setMemoContextMenu] = useState<MemoContextMenuState | null>(null);
  const [contextMoveOpen, setContextMoveOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<MemoFilterMode>("all");
  const [sortMode, setSortMode] = useState<MemoSortMode>("updated-desc");
  const [listDensity, setListDensity] = useState<MemoListDensity>(() => readMemoListDensityPreference());
  const [lastSelectedMemoId, setLastSelectedMemoId] = useState<string | null>(null);
  const filterOptions = MEMO_FILTER_OPTIONS;
  const mobileFilterOptions = useMemo(() => filterOptions.filter((option) => option.value !== "all"), [filterOptions]);
  const filteredMemos = useMemo(() => filterMemos(memos, filterMode), [filterMode, memos]);
  const sortedMemos = useMemo(() => sortMemos(filteredMemos, sortMode), [filteredMemos, sortMode]);
  const visibleMemoIds = useMemo(() => sortedMemos.map((memo) => memo.id), [sortedMemos]);
  const memoGroups = useMemo(() => groupMemos(sortedMemos, sortMode), [sortedMemos, sortMode]);
  const moveNotebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const canEnterSelectionMode = visibleMemoIds.length > 0;
  const selectedVisibleMemoCount = visibleMemoIds.filter((memoId) => selectedMemoIds.has(memoId)).length;
  const allVisibleMemosSelected = visibleMemoIds.length > 0 && selectedVisibleMemoCount === visibleMemoIds.length;
  const canToggleVisibleMemoSelection = visibleMemoIds.length > 0;
  const visibleSelectionToggleLabel = allVisibleMemosSelected ? "全不选当前列表" : "全选当前列表";
  const desktopFilterRef = useDismissableLayer<HTMLDivElement>(desktopFilterOpen, () => setDesktopFilterOpen(false));
  const desktopSortRef = useDismissableLayer<HTMLDivElement>(desktopSortOpen, () => setDesktopSortOpen(false));
  const desktopActionsRef = useDismissableLayer<HTMLDivElement>(desktopActionsOpen, () => setDesktopActionsOpen(false));
  const memoContextMenuRef = useDismissableLayer<HTMLDivElement>(Boolean(memoContextMenu), () => setMemoContextMenu(null));
  const listTitle = view === "trash" ? "回收站" : notebook?.name ?? "全部笔记";
  const listContextLabel = view === "trash" ? "已删除笔记" : notebook ? "当前笔记本" : "所有笔记本";
  const listCountLabel = `${filteredMemos.length}${filterMode !== "all" ? ` / ${memos.length}` : ""} ${
    view === "trash" ? "条已删除" : "条笔记"
  }`;
  const selectionCountLabel = getSelectionCountLabel(selectedMemoIds.size);
  const selectionMoveTitle =
    selectedMemoIds.size === 0
      ? "请选择笔记"
      : view === "trash"
        ? "回收站内不可移动"
        : notebooks.length === 0
          ? "没有可移动的笔记本"
          : isMoving
            ? "正在移动"
            : "移动";
  const selectionDeleteTitle =
    selectedMemoIds.size === 0 ? "请选择笔记" : isDeleting ? "正在删除" : view === "trash" ? "永久删除" : "删除";
  const selectionMergeTitle =
    selectedMemoIds.size < 2 ? "至少选择 2 条笔记" : view === "trash" ? "回收站内不可合并" : isMerging ? "正在合并" : "合并笔记";
  const selectionToggleTitle = canToggleVisibleMemoSelection ? visibleSelectionToggleLabel : "当前列表没有可选择的笔记";
  const moveTargetTitle =
    view === "trash" ? "回收站内不可移动" : notebooks.length === 0 ? "没有可移动的笔记本" : isMoving ? "正在移动" : "移动到笔记本";
  const hasListConstraint = Boolean(search.trim()) || filterMode !== "all";
  const activeFilterLabel = filterOptions.find((option) => option.value === filterMode)?.label ?? "全部";
  const activeSortLabel = MEMO_SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? "最近更新";

  useEffect(() => {
    if (notebook?.id) {
      setMoveTargetNotebookId(notebook.id);
      return;
    }

    if (!moveTargetNotebookId && moveNotebookOptions[0]?.id) {
      setMoveTargetNotebookId(moveNotebookOptions[0].id);
    }
  }, [moveNotebookOptions, moveTargetNotebookId, notebook?.id]);

  useEffect(() => {
    if (searchFocusToken === 0) {
      return;
    }

    searchInputRef.current?.focus();
  }, [searchFocusToken]);

  useEffect(() => {
    if (!filterOptions.some((option) => option.value === filterMode)) {
      setFilterMode("all");
    }
  }, [filterMode, filterOptions]);

  useEffect(() => {
    if (!selectedMemoId || !visibleMemoIds.includes(selectedMemoId) || !window.matchMedia("(min-width: 1024px)").matches) {
      return;
    }

    const scrollContainer = listScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const escapedMemoId = CSS.escape(selectedMemoId);
    const selectedNode = scrollContainer.querySelector<HTMLElement>(`[data-memo-id="${escapedMemoId}"]`);

    if (!selectedNode) {
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const selectedRect = selectedNode.getBoundingClientRect();
    const stickyHeaderOffset = 40;

    if (selectedRect.top < containerRect.top + stickyHeaderOffset) {
      scrollContainer.scrollTop -= containerRect.top + stickyHeaderOffset - selectedRect.top;
      return;
    }

    if (selectedRect.bottom > containerRect.bottom) {
      scrollContainer.scrollTop += selectedRect.bottom - containerRect.bottom;
    }
  }, [selectedMemoId, visibleMemoIds]);

  useEffect(() => {
    if (!selectionMode) {
      setMobileMoveOpen(false);
      setMobileMoreOpen(false);
      return;
    }

    setDesktopActionsOpen(false);
    setDesktopFilterOpen(false);
    setDesktopSortOpen(false);
    setContextMoveOpen(false);
    setMemoContextMenu(null);
    setMobileListActionsOpen(false);
    setMobileMoveOpen(false);
    setMobileMoreOpen(false);
  }, [selectionMode]);

  const handleToggleMemo = (memoId: string, event?: MouseEvent<HTMLElement>) => {
    const currentIndex = visibleMemoIds.indexOf(memoId);
    const anchorIndex = lastSelectedMemoId ? visibleMemoIds.indexOf(lastSelectedMemoId) : -1;

    if (event?.shiftKey && currentIndex >= 0 && anchorIndex >= 0) {
      const start = Math.min(currentIndex, anchorIndex);
      const end = Math.max(currentIndex, anchorIndex);
      onToggleMemo(memoId, visibleMemoIds.slice(start, end + 1));
    } else {
      onToggleMemo(memoId);
    }

    setLastSelectedMemoId(memoId);
  };

  const handleSelectAllVisibleMemos = () => {
    if (visibleMemoIds.length === 0) {
      return;
    }

    onReplaceSelection(visibleMemoIds);
    setLastSelectedMemoId(visibleMemoIds.at(-1) ?? visibleMemoIds[0]);
  };

  const handleClearVisibleMemos = () => {
    const nextSelectedMemoIds = Array.from(selectedMemoIds).filter((memoId) => !visibleMemoIds.includes(memoId));

    onReplaceSelection(nextSelectedMemoIds);
    setLastSelectedMemoId(null);
  };

  const handleOpenMemoContextMenu = (memo: MemoSummary, event: MouseEvent<HTMLElement>) => {
    const menuWidth = 224;
    const menuHeight = view === "trash" ? 160 : 260;
    const x = Math.min(event.clientX, Math.max(12, window.innerWidth - menuWidth - 12));
    const y = Math.min(event.clientY, Math.max(12, window.innerHeight - menuHeight - 12));

    setContextMoveOpen(false);
    setMemoContextMenu({ memo, x, y });
  };

  const handleClearSearch = () => {
    onSearch("");
    searchInputRef.current?.focus();
  };

  const handleResetListConstraints = () => {
    setFilterMode("all");
    onSearch("");
    searchInputRef.current?.focus();
  };

  const handleListDensityChange = (value: MemoListDensity) => {
    setListDensity(value);
    writeMemoListDensityPreference(value);
  };

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(min-width: 1024px)").matches) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;

    if (target?.closest("input, textarea, select, [contenteditable='true']")) {
      return;
    }

    if (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      if (visibleMemoIds.length === 0) {
        return;
      }

      event.preventDefault();
      setMemoContextMenu(null);
      handleSelectAllVisibleMemos();
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const currentIndex = selectedMemoId ? visibleMemoIds.indexOf(selectedMemoId) : -1;

    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      if (visibleMemoIds.length === 0) {
        return;
      }

      event.preventDefault();
      setMemoContextMenu(null);

      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visibleMemoIds.length - 1
            : event.key === "ArrowDown"
              ? Math.min(currentIndex < 0 ? 0 : currentIndex + 1, visibleMemoIds.length - 1)
              : Math.max(currentIndex < 0 ? 0 : currentIndex - 1, 0);
      const nextMemoId = visibleMemoIds[nextIndex];

      onOpenMemo(nextMemoId);
      setLastSelectedMemoId(nextMemoId);
      return;
    }

    if (event.key === "Enter") {
      if (!selectedMemoId || !visibleMemoIds.includes(selectedMemoId)) {
        return;
      }

      event.preventDefault();
      setMemoContextMenu(null);
      onOpenMemo(selectedMemoId);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectionMode && selectedMemoIds.size > 0) {
        event.preventDefault();
        setMemoContextMenu(null);
        onDeleteSelectedMemos();
        return;
      }

      if (!selectedMemoId || !visibleMemoIds.includes(selectedMemoId)) {
        return;
      }

      event.preventDefault();
      setMemoContextMenu(null);
      onDeleteMemo(selectedMemoId);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col outline-none" tabIndex={0} onKeyDown={handleListKeyDown}>
      <header className="border-b border-emerald-100 bg-white px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:py-3">
        {selectionMode ? (
          <div className="mb-3 flex h-10 min-w-0 items-center gap-3 lg:hidden">
            <button
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              type="button"
              title="取消选择"
              aria-label="取消选择"
              onClick={onClearSelection}
            >
              <X className="h-5 w-5" />
            </button>
            <div className="min-w-0 truncate text-lg font-semibold text-slate-900">{selectionCountLabel}</div>
          </div>
        ) : (
          <MobileHomeHeader
            isOnline={isOnline}
            isSyncingQueuedChanges={isSyncingQueuedChanges}
            user={user}
            onSyncQueuedChanges={onSyncQueuedChanges}
          />
        )}
        <MobileQuickActions
          canCreateMemo={canCreateMemo && view !== "trash"}
          isCreating={isCreating}
          locked={selectionMode}
          onCreateChecklist={onCreateChecklist}
          onCreateMemo={onCreateMemo}
          onOpenAssets={onOpenAssets}
          onOpenTags={onOpenTags}
          onOpenTemplates={onOpenTemplates}
        />
        <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <button
              className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-left transition hover:bg-emerald-50 lg:hidden"
              type="button"
              title="切换笔记本"
              aria-label="切换笔记本"
              onClick={onOpenNotebookPicker}
            >
              <span className="max-w-[190px] truncate text-lg font-semibold text-slate-950">{listTitle}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
            </button>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-emerald-50 hover:text-emerald-700"
            type="button"
            title="列表选项"
            aria-label="列表选项"
            aria-expanded={mobileListActionsOpen}
            onClick={() => setMobileListActionsOpen(true)}
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        </div>
        <div className="mb-3 hidden min-w-0 lg:block">
          <div className="truncate text-lg font-semibold leading-6 text-slate-950">{listTitle}</div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {listContextLabel} · {listCountLabel}
          </div>
        </div>
        <div className="mb-3 hidden items-center justify-between gap-2 lg:flex">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              title="选择笔记"
              onClick={onEnterSelectionMode}
              disabled={!canEnterSelectionMode}
            >
              <CheckSquare className="h-4 w-4" />
            </Button>
            <div className="relative" ref={desktopFilterRef}>
              <button
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-xs font-medium transition",
                  filterMode === "all"
                    ? "border-emerald-100 bg-white text-slate-600 hover:bg-emerald-50 hover:text-emerald-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                )}
                type="button"
                title={`筛选：${activeFilterLabel}`}
                aria-label={`筛选：${activeFilterLabel}`}
                aria-expanded={desktopFilterOpen}
                onClick={() => {
                  setDesktopSortOpen(false);
                  setDesktopActionsOpen(false);
                  setDesktopFilterOpen((value) => !value);
                }}
              >
                {getMobileFilterIcon(filterMode)}
              </button>
              {desktopFilterOpen ? (
                <div className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-panel">
                  {filterOptions.map((option) => (
                    <button
                      key={option.value}
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                      type="button"
                      onClick={() => {
                        setFilterMode(option.value);
                        setDesktopFilterOpen(false);
                      }}
                    >
                      {getMobileFilterIcon(option.value)}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <CheckCircle2
                        className={cn("h-4 w-4 shrink-0", filterMode === option.value ? "text-emerald-600" : "text-transparent")}
                      />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="relative" ref={desktopSortRef}>
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-100 bg-white text-xs font-medium text-slate-600 transition hover:bg-emerald-50 hover:text-emerald-800"
                type="button"
                title={`排序：${activeSortLabel}`}
                aria-label={`排序：${activeSortLabel}`}
                aria-expanded={desktopSortOpen}
                onClick={() => {
                  setDesktopFilterOpen(false);
                  setDesktopActionsOpen(false);
                  setDesktopSortOpen((value) => !value);
                }}
              >
                <ArrowDownWideNarrow className="h-4 w-4" />
              </button>
              {desktopSortOpen ? (
                <div className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-panel">
                  {MEMO_SORT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                      type="button"
                      onClick={() => {
                        setSortMode(option.value);
                        setDesktopSortOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <CheckCircle2
                        className={cn("h-4 w-4 shrink-0", sortMode === option.value ? "text-emerald-600" : "text-transparent")}
                      />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex h-8 shrink-0 overflow-hidden rounded-md border border-emerald-100 bg-white">
              <button
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center transition",
                  listDensity === "preview" ? "bg-emerald-100 text-emerald-950" : "text-slate-500 hover:bg-emerald-50"
                )}
                type="button"
                title="预览列表"
                onClick={() => handleListDensityChange("preview")}
              >
                <LayoutList className="h-4 w-4" />
              </button>
              <button
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center border-l border-emerald-100 transition",
                  listDensity === "compact" ? "bg-emerald-100 text-emerald-950" : "text-slate-500 hover:bg-emerald-50"
                )}
                type="button"
                title="紧凑列表"
                onClick={() => handleListDensityChange("compact")}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="solid"
              title="新建笔记"
              onClick={onCreateMemo}
              disabled={!canCreateMemo || isCreating || view === "trash"}
            >
              <FilePlus2 className="h-4 w-4" />
            </Button>
            <div className="relative" ref={desktopActionsRef}>
              <Button
                size="icon"
                variant="ghost"
                title="更多"
                onClick={() => {
                  setDesktopFilterOpen(false);
                  setDesktopSortOpen(false);
                  setDesktopActionsOpen((value) => !value);
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {desktopActionsOpen ? (
                <div className="absolute right-0 top-9 z-30 w-40 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-panel">
                  <button
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => {
                      setDesktopActionsOpen(false);
                      onOpenTags();
                    }}
                  >
                    <Tags className="h-4 w-4" />
                    标签
                  </button>
                  <button
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => {
                      setDesktopActionsOpen(false);
                      onOpenAssets();
                    }}
                  >
                    <Archive className="h-4 w-4" />
                    附件
                  </button>
                  <button
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => {
                      setDesktopActionsOpen(false);
                      onOpenTrash();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    回收站
                  </button>
                  <button
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => {
                      setDesktopActionsOpen(false);
                      onOpenSettings();
                    }}
                  >
                    <UserRound className="h-4 w-4" />
                    我的
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-emerald-100 bg-emerald-50/70 px-3 text-sm text-slate-500">
            <Search className="h-4 w-4" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  handleClearSearch();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
              placeholder="搜索笔记"
            />
            {search ? (
              <button
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700"
                type="button"
                title="清空搜索"
                aria-label="清空搜索"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleClearSearch}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 lg:hidden">
            {mobileFilterOptions.map((option) => (
              <button
                key={option.value}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border transition",
                  filterMode === option.value
                    ? "border-emerald-600 bg-emerald-600 text-white shadow-[0_8px_18px_rgba(5,150,105,0.22)]"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                )}
                type="button"
                title={filterMode === option.value ? `取消${option.label}` : option.label}
                aria-label={filterMode === option.value ? `取消${option.label}` : option.label}
                aria-pressed={filterMode === option.value}
                onClick={() => setFilterMode(filterMode === option.value ? "all" : option.value)}
              >
                {getMobileFilterIcon(option.value)}
              </button>
            ))}
          </div>
        </div>
        {hasListConstraint ? (
          <div className="mt-3 flex min-h-8 items-center gap-2 rounded-md border border-emerald-100 bg-white px-3 py-1.5 text-xs text-slate-500">
            <span className="min-w-0 flex-1 truncate">
              {search.trim() ? `搜索「${search.trim()}」` : `筛选：${activeFilterLabel}`} · {filteredMemos.length} 条
            </span>
            <button
              className="shrink-0 font-semibold text-emerald-700 transition hover:text-emerald-900"
              type="button"
              onClick={handleResetListConstraints}
            >
              重置
            </button>
          </div>
        ) : null}
      </header>

      <div ref={listScrollRef} className="relative min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(7rem+env(safe-area-inset-bottom))] lg:pb-3">
        {selectionMode ? (
          <div className="sticky top-0 z-10 mb-3 hidden flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-100 bg-white px-3 py-2 shadow-panel lg:flex">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckSquare className="h-4 w-4 text-emerald-700" />
              {selectionCountLabel}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                title={selectionToggleTitle}
                onClick={allVisibleMemosSelected ? handleClearVisibleMemos : handleSelectAllVisibleMemos}
                disabled={!canToggleVisibleMemoSelection}
              >
                <CheckSquare className="h-4 w-4" />
                {allVisibleMemosSelected ? "全不选" : "全选"}
              </Button>
              <Button size="sm" variant="ghost" title="取消选择" onClick={onClearSelection}>
                <X className="h-4 w-4" />
                取消
              </Button>
              <select
                className="h-8 max-w-40 rounded-md border border-emerald-100 bg-emerald-50/70 px-2 text-xs text-emerald-900 outline-none disabled:opacity-50"
                value={moveTargetNotebookId}
                disabled={view === "trash" || notebooks.length === 0 || isMoving}
                onChange={(event) => setMoveTargetNotebookId(event.target.value)}
                title={moveTargetTitle}
              >
                {moveNotebookOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.selectLabel}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="soft"
                title={selectionMoveTitle}
                onClick={() => onMoveSelectedMemos(moveTargetNotebookId)}
                disabled={selectedMemoIds.size === 0 || !moveTargetNotebookId || isMoving || view === "trash"}
              >
                <Folder className="h-4 w-4" />
                移动
              </Button>
              <Button
                size="sm"
                variant="solid"
                title={selectionMergeTitle}
                onClick={onMerge}
                disabled={selectedMemoIds.size < 2 || isMerging || view === "trash"}
              >
                <Merge className="h-4 w-4" />
                合并
              </Button>
              <Button
                size="sm"
                variant="danger"
                title={selectionDeleteTitle}
                onClick={onDeleteSelectedMemos}
                disabled={selectedMemoIds.size === 0 || isDeleting}
              >
                <Trash2 className="h-4 w-4" />
                {view === "trash" ? "永久删除" : "删除"}
              </Button>
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <div className="px-2 py-4 text-sm text-slate-500">加载中</div>
        ) : filteredMemos.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-9 text-center">
            <div className="text-sm font-semibold text-slate-800">
              {memos.length === 0 ? (view === "trash" ? "回收站为空" : "暂无笔记") : "没有符合筛选的笔记"}
            </div>
            <div className="mx-auto mt-2 max-w-[260px] text-xs leading-5 text-slate-500">
              {memos.length === 0
                ? view === "trash"
                  ? "删除的笔记会显示在这里。"
                  : "先创建一条笔记，之后可以在这里快速预览、搜索和批量整理。"
                : "试试切换筛选条件，或调整搜索关键词。"}
            </div>
            {memos.length === 0 && canCreateMemo && view !== "trash" ? (
              <Button className="mt-4 justify-center" size="sm" variant="solid" onClick={onCreateMemo} disabled={isCreating}>
                <FilePlus2 className="h-4 w-4" />
                新建笔记
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 lg:space-y-0 lg:overflow-hidden lg:rounded-sm lg:border-y lg:border-slate-200 lg:bg-white">
            {memoGroups.map((group) => (
              <section key={group.key}>
                <div className="sticky top-0 z-[4] flex h-9 items-center justify-between bg-emerald-50/95 px-1 text-sm font-semibold text-slate-400 backdrop-blur lg:border-b lg:border-slate-200 lg:bg-white/95 lg:px-4 lg:text-slate-500">
                  <span>{group.label}</span>
                  <span>{group.items.length}</span>
                </div>
                <div className="space-y-3 lg:space-y-0">
                  {group.items.map((memo) => (
                    <MemoCard
                      key={memo.id}
                      memo={memo}
                      selected={memo.id === selectedMemoId}
                      checked={selectedMemoIds.has(memo.id)}
                      isTrashView={view === "trash"}
                      selectionMode={selectionMode}
                      listDensity={listDensity}
                      multiSelectKeyDown={multiSelectKeyDown}
                      onOpen={() => onOpenMemo(memo.id)}
                      onDelete={() => onDeleteMemo(memo.id)}
                      onRestore={() => onRestoreMemo(memo.id)}
                      onOpenContextMenu={(event) => handleOpenMemoContextMenu(memo, event)}
                      onToggle={(event) => handleToggleMemo(memo.id, event)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {memoContextMenu ? (
        <div
          ref={memoContextMenuRef}
          className="fixed z-50 hidden w-56 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-panel lg:block"
          style={{ left: memoContextMenu.x, top: memoContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            type="button"
            onClick={() => {
              const { memo } = memoContextMenu;
              setMemoContextMenu(null);
              onOpenMemo(memo.id);
            }}
          >
            <FileIcon className="h-4 w-4" />
            打开笔记
          </button>
          <button
            className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
            type="button"
            onClick={() => {
              const { memo } = memoContextMenu;
              setMemoContextMenu(null);
              handleToggleMemo(memo.id);
            }}
          >
            <CheckSquare className="h-4 w-4" />
            选择笔记
          </button>
          <div className="my-1 h-px bg-slate-100" />
          {view === "trash" ? (
            <>
              <button
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                type="button"
                onClick={() => {
                  const { memo } = memoContextMenu;
                  setMemoContextMenu(null);
                  onRestoreMemo(memo.id);
                }}
              >
                <RotateCcw className="h-4 w-4" />
                恢复笔记
              </button>
              <button
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                type="button"
                onClick={() => {
                  const { memo } = memoContextMenu;
                  setMemoContextMenu(null);
                  onDeleteMemo(memo.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
                永久删除
              </button>
            </>
          ) : (
            <>
              <button
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                type="button"
                disabled={moveNotebookOptions.length === 0}
                onClick={() => setContextMoveOpen((value) => !value)}
              >
                <Folder className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">移动到笔记本</span>
                <ChevronRight className={cn("h-4 w-4 transition", contextMoveOpen && "rotate-90")} />
              </button>
              {contextMoveOpen ? (
                <div className="max-h-52 overflow-y-auto border-y border-slate-100 bg-slate-50/60 py-1">
                  {moveNotebookOptions.map((option) => (
                    <button
                      key={option.id}
                      className={cn(
                        "flex h-9 w-full items-center gap-2 px-3 text-left text-sm transition hover:bg-white",
                        option.id === memoContextMenu.memo.notebookId ? "font-semibold text-emerald-700" : "text-slate-700"
                      )}
                      style={{ paddingLeft: `${12 + option.depth * 14}px` }}
                      type="button"
                      disabled={option.id === memoContextMenu.memo.notebookId}
                      onClick={() => {
                        const { memo } = memoContextMenu;
                        setContextMoveOpen(false);
                        setMemoContextMenu(null);
                        onMoveMemo(memo.id, option.id);
                      }}
                    >
                      {option.slug === "inbox" ? <Inbox className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {option.id === memoContextMenu.memo.notebookId ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                type="button"
                onClick={() => {
                  const { memo } = memoContextMenu;
                  setMemoContextMenu(null);
                  onDeleteMemo(memo.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
                删除笔记
              </button>
            </>
          )}
        </div>
      ) : null}
      {selectionMode ? (
        <MobileSelectionActionBar
          canDelete={selectedMemoIds.size > 0 && !isDeleting}
          canMove={selectedMemoIds.size > 0 && view !== "trash" && notebooks.length > 0 && !isMoving}
          deleteTitle={selectionDeleteTitle}
          isTrashView={view === "trash"}
          moveTitle={selectionMoveTitle}
          onDelete={onDeleteSelectedMemos}
          onOpenMore={() => setMobileMoreOpen(true)}
          onOpenMove={() => setMobileMoveOpen(true)}
        />
      ) : null}
      {mobileListActionsOpen ? (
        <MobileListActionsSheet
          canSelectMemos={canEnterSelectionMode}
          isSelectionMode={selectionMode}
          listDensity={listDensity}
          sortMode={sortMode}
          onClose={() => setMobileListActionsOpen(false)}
          onEnterSelectionMode={() => {
            setMobileListActionsOpen(false);
            onEnterSelectionMode();
          }}
          onOpenAssets={() => {
            setMobileListActionsOpen(false);
            onOpenAssets();
          }}
          onOpenSettings={() => {
            setMobileListActionsOpen(false);
            onOpenSettings();
          }}
          onOpenTags={() => {
            setMobileListActionsOpen(false);
            onOpenTags();
          }}
          onOpenTrash={() => {
            setMobileListActionsOpen(false);
            onOpenTrash();
          }}
          onListDensityChange={(value) => {
            handleListDensityChange(value);
          }}
          onSortModeChange={(value) => {
            setSortMode(value);
          }}
        />
      ) : null}
      {mobileMoveOpen ? (
        <MobileMoveSheet
          isMoving={isMoving}
          notebooks={notebooks}
          selectedCount={selectedMemoIds.size}
          selectedNotebookId={moveTargetNotebookId}
          onClose={() => setMobileMoveOpen(false)}
          onMove={(notebookId) => {
            setMoveTargetNotebookId(notebookId);
            onMoveSelectedMemos(notebookId);
            setMobileMoveOpen(false);
          }}
        />
      ) : null}
      {mobileMoreOpen ? (
        <MobileSelectionMoreSheet
          canMerge={selectedMemoIds.size >= 2 && view !== "trash" && !isMerging}
          canToggleVisibleSelection={canToggleVisibleMemoSelection}
          mergeTitle={selectionMergeTitle}
          selectedCount={selectedMemoIds.size}
          selectionToggleLabel={visibleSelectionToggleLabel}
          selectionToggleTitle={selectionToggleTitle}
          onToggleVisibleSelection={() => {
            setMobileMoreOpen(false);
            if (allVisibleMemosSelected) {
              handleClearVisibleMemos();
              return;
            }

            handleSelectAllVisibleMemos();
          }}
          onClearSelection={() => {
            setMobileMoreOpen(false);
            onClearSelection();
          }}
          onClose={() => setMobileMoreOpen(false)}
          onMerge={() => {
            setMobileMoreOpen(false);
            onMerge();
          }}
        />
      ) : null}
    </div>
  );
};

const sortMemos = (memos: MemoSummary[], sortMode: MemoSortMode) =>
  [...memos].sort((first, second) => {
    if (sortMode === "title-asc") {
      const titleCompare = getMemoTitle(first.title).localeCompare(getMemoTitle(second.title), "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });

      if (titleCompare !== 0) {
        return titleCompare;
      }

      return compareDateDesc(first.updatedAt, second.updatedAt);
    }

    if (sortMode === "created-desc") {
      return compareDateDesc(first.createdAt, second.createdAt);
    }

    return compareDateDesc(first.updatedAt, second.updatedAt);
  });

const filterMemos = (memos: MemoSummary[], filterMode: MemoFilterMode) => {
  if (filterMode === "tagged") {
    return memos.filter((memo) => memo.tags.length > 0);
  }

  if (filterMode === "untagged") {
    return memos.filter((memo) => memo.tags.length === 0);
  }

  if (filterMode === "pinned") {
    return memos.filter((memo) => memo.isPinned);
  }

  return memos;
};

const getMobileFilterIcon = (filterMode: MemoFilterMode) => {
  if (filterMode === "tagged") {
    return <Tags className="h-4 w-4" />;
  }

  if (filterMode === "untagged") {
    return <TagX className="h-4 w-4" />;
  }

  if (filterMode === "pinned") {
    return <Star className="h-4 w-4" />;
  }

  return <LayoutList className="h-4 w-4" />;
};

const groupMemos = (memos: MemoSummary[], sortMode: MemoSortMode) =>
  sortMode === "title-asc" ? groupMemosByTitle(memos) : groupMemosByDate(memos, sortMode);

const groupMemosByDate = (memos: MemoSummary[], sortMode: MemoSortMode) => {
  const groups: Array<{ key: string; label: string; items: MemoSummary[] }> = [];

  for (const memo of memos) {
    const date = new Date(sortMode === "created-desc" ? memo.createdAt : memo.updatedAt);
    const { key, label } = getMemoMonthGroup(date);
    const current = groups[groups.length - 1];

    if (current?.key === key) {
      current.items.push(memo);
      continue;
    }

    groups.push({ key, label, items: [memo] });
  }

  return groups;
};

const getMemoMonthGroup = (date: Date) => {
  if (Number.isNaN(date.getTime())) {
    return { key: "unknown", label: "未知时间" };
  }

  return {
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(date),
  };
};

const groupMemosByTitle = (memos: MemoSummary[]) => {
  const groups: Array<{ key: string; label: string; items: MemoSummary[] }> = [];

  for (const memo of memos) {
    const title = getMemoTitle(memo.title);
    const firstChar = title.trim().charAt(0).toLocaleUpperCase("zh-CN");
    const label = firstChar || "#";
    const current = groups[groups.length - 1];

    if (current?.key === label) {
      current.items.push(memo);
      continue;
    }

    groups.push({ key: label, label, items: [memo] });
  }

  return groups;
};

const compareDateDesc = (first: string, second: string) => {
  const firstTime = Date.parse(first);
  const secondTime = Date.parse(second);

  if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) {
    return 0;
  }

  if (Number.isNaN(firstTime)) {
    return 1;
  }

  if (Number.isNaN(secondTime)) {
    return -1;
  }

  return secondTime - firstTime;
};

const getNotebookMoveOptions = (notebooks: Notebook[]) => {
  const options: NotebookMoveOption[] = [];
  const walk = (nodes: NotebookNode[], depth: number) => {
    for (const node of nodes) {
      options.push({
        id: node.id,
        name: node.name,
        selectLabel: `${"\u00A0\u00A0".repeat(depth)}${depth > 0 ? "└ " : ""}${node.name}`,
        slug: node.slug,
        depth,
      });
      walk(node.children, depth + 1);
    }
  };

  walk(buildNotebookTree(notebooks), 0);
  return options;
};

const MemoCard = ({
  memo,
  selected,
  checked,
  isTrashView,
  selectionMode,
  listDensity,
  multiSelectKeyDown,
  onOpen,
  onDelete,
  onRestore,
  onOpenContextMenu,
  onToggle,
}: {
  memo: MemoSummary;
  selected: boolean;
  checked: boolean;
  isTrashView: boolean;
  selectionMode: boolean;
  listDensity: MemoListDensity;
  multiSelectKeyDown: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onOpenContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onToggle: (event?: MouseEvent<HTMLElement>) => void;
}) => {
  const handledModifierPointerRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
  const memoTitle = getMemoTitle(memo.title);
  const memoExcerpt = memo.excerpt.trim() || "空笔记";
  const showSelectionControl = selectionMode || checked || multiSelectKeyDown;

  const shouldToggleSelection = (event: MouseEvent<HTMLElement>) =>
    event.ctrlKey || event.metaKey || event.shiftKey || multiSelectKeyDown;

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current === null) {
      return;
    }

    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const resetLongPress = () => {
    clearLongPressTimer();
    longPressPointRef.current = null;
  };

  useEffect(() => () => resetLongPress(), []);

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
    onToggle(event);
  };

  const handleLongPressSelection = () => {
    markModifierPointerHandled();

    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(8);
    }

    onToggle();
  };

  const handleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    if (shouldToggleSelection(event)) {
      handleModifierToggle(event);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch" || selectionMode) {
      return;
    }

    clearLongPressTimer();
    longPressPointRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressPointRef.current = null;
      handleLongPressSelection();
    }, MEMO_LONG_PRESS_DELAY_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch" || !longPressPointRef.current) {
      return;
    }

    const xDistance = Math.abs(event.clientX - longPressPointRef.current.x);
    const yDistance = Math.abs(event.clientY - longPressPointRef.current.y);

    if (xDistance > MEMO_LONG_PRESS_MOVE_TOLERANCE_PX || yDistance > MEMO_LONG_PRESS_MOVE_TOLERANCE_PX) {
      resetLongPress();
    }
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") {
      resetLongPress();
    }
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (handledModifierPointerRef.current) {
      event.preventDefault();
      event.stopPropagation();
      handledModifierPointerRef.current = false;
      return;
    }

    if (selectionMode) {
      event.preventDefault();
      event.stopPropagation();
      onToggle(event);
      return;
    }

    if (shouldToggleSelection(event)) {
      handleModifierToggle(event);
      return;
    }

    onOpen();
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (longPressPointRef.current) {
      event.preventDefault();
      event.stopPropagation();
      resetLongPress();
      handleLongPressSelection();
      return;
    }

    if (selectionMode) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (handledModifierPointerRef.current) {
      return;
    }

    if (shouldToggleSelection(event)) {
      markModifierPointerHandled();
      onToggle(event);
      return;
    }

    if (window.matchMedia("(min-width: 1024px)").matches) {
      onOpenContextMenu(event);
    }
  };

  return (
    <article
      data-memo-id={memo.id}
      className={cn(
        "group overflow-hidden border border-slate-100 bg-white transition lg:rounded-none lg:border-x-0 lg:border-t-0 lg:border-slate-200 lg:shadow-none lg:last:border-b-0",
        listDensity === "compact" ? "rounded-md shadow-none" : "rounded-xl shadow-[0_10px_26px_rgba(15,23,42,0.06)]",
        !selectionMode && selected
          ? "lg:bg-slate-200"
          : checked
            ? "bg-slate-100 shadow-none ring-0 lg:bg-slate-100 lg:ring-0"
            : "active:bg-slate-50 lg:hover:bg-slate-50"
      )}
    >
      <div className={cn("flex min-h-[132px] items-center", listDensity === "compact" && "min-h-[84px] lg:min-h-[76px]")}>
        {showSelectionControl ? (
          <button
            className={cn(
              "ml-4 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition",
              checked ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-transparent"
            )}
            type="button"
            aria-label={`选择 ${memoTitle}`}
            aria-pressed={checked}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(event);
            }}
          >
            <Check className="h-5 w-5 stroke-[3]" />
          </button>
        ) : null}
        <button
          className={cn(
            "min-w-0 flex-1 select-none px-4 py-4 text-left touch-pan-y [-webkit-touch-callout:none] lg:py-4",
            listDensity === "compact" && "py-3",
            showSelectionControl && "pl-3 lg:pl-3",
            multiSelectKeyDown && "cursor-copy"
          )}
          onMouseDown={handleMouseDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={resetLongPress}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title="Ctrl/Cmd 点击切换选择，Shift 点击连续选择，移动端长按进入选择"
        >
          <div className={cn("mb-2 truncate text-base font-semibold leading-6 text-slate-900 lg:text-base", listDensity === "compact" && "mb-1")}>
            {memoTitle}
          </div>
          <div
            className={cn(
              "line-clamp-2 min-h-10 text-[15px] leading-5 text-slate-600",
              listDensity === "compact" && "line-clamp-1 min-h-0 text-sm"
            )}
          >
            {memoExcerpt}
          </div>
          <div className={cn("mt-5 flex flex-wrap items-center gap-2", listDensity === "compact" && "mt-2")}>
            <time className="text-xs font-medium text-slate-400 lg:text-sm lg:font-normal lg:text-slate-500">{formatMemoPreviewDate(memo.updatedAt)}</time>
            {memo.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
                #{tag}
              </span>
            ))}
          </div>
        </button>
        {!selectionMode ? (
          <button
            className={cn(
              "mr-3 mt-4 hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 transition group-hover:opacity-100 lg:flex",
              isTrashView ? "hover:bg-emerald-50 hover:text-emerald-700" : "hover:bg-rose-50 hover:text-rose-700",
              selected && "opacity-100",
              listDensity === "compact" && "lg:mt-3"
            )}
            type="button"
            title={isTrashView ? "恢复笔记" : "删除笔记"}
            onClick={(event) => {
              event.stopPropagation();
              if (isTrashView) {
                onRestore();
                return;
              }

              onDelete();
            }}
          >
            {isTrashView ? <RotateCcw className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          </button>
        ) : null}
      </div>
    </article>
  );
};

const getMemoTitle = (title: string | null | undefined) => title?.trim() || DEFAULT_MEMO_TITLE;

const formatMemoPreviewDate = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const memoDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

  if (memoDay === today) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  if (memoDay === today - 24 * 60 * 60 * 1000) {
    return "昨天";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
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

const TemplatesDialog = ({
  canCreateMemo,
  isCreating,
  onClose,
  onCreateMemo,
}: {
  canCreateMemo: boolean;
  isCreating: boolean;
  onClose: () => void;
  onCreateMemo: (template: MemoTemplate) => void;
}) => (
  <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
    <section
      className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[620px] sm:rounded-md"
      onClick={(event) => event.stopPropagation()}
    >
      <MobileSheetGrabber />
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
            <LayoutList className="h-4 w-4 text-emerald-700" />
            模板
          </div>
          <div className="mt-1 text-xs text-slate-500">选择一个模板，直接创建新笔记。</div>
        </div>
        <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {MEMO_TEMPLATES.map((template) => (
            <button
              key={template.id}
              className="group flex min-h-28 flex-col rounded-md border border-emerald-100 bg-emerald-50/30 p-3 text-left transition hover:border-emerald-200 hover:bg-emerald-50 disabled:opacity-50"
              type="button"
              disabled={!canCreateMemo || isCreating}
              onClick={() => onCreateMemo(template)}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-emerald-100 bg-white text-emerald-700 transition group-hover:border-emerald-200">
                <FileIcon className="h-4 w-4" />
              </span>
              <span className="mt-3 text-sm font-semibold text-slate-950">{template.title}</span>
              <span className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{template.description}</span>
            </button>
          ))}
        </div>
        {!canCreateMemo ? (
          <div className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            当前无法创建笔记，请先选择可用笔记本。
          </div>
        ) : null}
      </div>
    </section>
  </div>
);

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
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <section
        className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[760px] sm:rounded-md"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
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
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <section
        className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[680px] sm:rounded-md"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
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
                      {tag.memoCount} 条笔记{tag.updatedAt ? ` · ${formatDateTime(tag.updatedAt)}` : ""}
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
  const [name, setName] = useState("MCP Agent");
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
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6"
      onClick={createdToken ? undefined : onClose}
    >
      <section
        className="flex max-h-[92dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[820px] sm:rounded-md"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <KeyRound className="h-4 w-4 text-emerald-700" />
              设置
            </div>
            <div className="mt-1 truncate text-xs text-slate-500">API Token / MCP</div>
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
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-0 sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <section
        className="flex max-h-[88dvh] w-full flex-col rounded-t-md bg-white shadow-panel sm:max-w-[980px] sm:rounded-md"
        onClick={(event) => event.stopPropagation()}
      >
        <MobileSheetGrabber />
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-100 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <History className="h-4 w-4 text-emerald-700" />
              版本历史
            </div>
            <div className="mt-1 truncate text-xs text-slate-500">{getMemoTitle(memo.title)}</div>
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
      {markdown || "空笔记"}
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

const syncStatusToSaveState = (status: "pending" | "syncing" | "conflict" | "error") => {
  if (status === "conflict") {
    return "conflict";
  }

  if (status === "syncing") {
    return "saving";
  }

  return "queued";
};

class MemoSaveRequestError extends Error {
  originalError: unknown;
  payload: MemoUpdateSyncPayload;
  tagsText: string;

  constructor(originalError: unknown, payload: MemoUpdateSyncPayload, tagsText: string) {
    super(originalError instanceof Error ? originalError.message : "Memo save failed");
    this.name = "MemoSaveRequestError";
    this.originalError = originalError;
    this.payload = payload;
    this.tagsText = tagsText;
  }
}

const EditorToolbar = ({ editor, readOnly }: { editor: Editor | null; readOnly: boolean }) => {
  const disabled = readOnly || !editor;
  const blockValue = getActiveBlockValue(editor);
  const canRun = (command: (editor: Editor) => boolean) => {
    if (!editor || readOnly) {
      return false;
    }

    return command(editor);
  };
  const run = (command: (editor: Editor) => void) => {
    if (!editor || readOnly) {
      return;
    }

    command(editor);
  };

  const setBlock = (value: string) => {
    run((current) => {
      const chain = current.chain().focus();

      if (value === "paragraph") {
        chain.setParagraph().run();
        return;
      }

      if (value === "heading-1") {
        chain.setHeading({ level: 1 }).run();
        return;
      }

      if (value === "heading-2") {
        chain.setHeading({ level: 2 }).run();
        return;
      }

      if (value === "heading-3") {
        chain.setHeading({ level: 3 }).run();
      }
    });
  };

  return (
    <div className="relative border-t border-emerald-100 bg-emerald-50/35">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r from-emerald-50/95 to-transparent sm:hidden" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-gradient-to-l from-emerald-50/95 to-transparent sm:hidden" />
      <div className="flex min-h-12 items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden">
        <select
          className="h-8 w-28 shrink-0 rounded-md border border-emerald-100 bg-white px-2 text-xs font-medium text-emerald-950 outline-none disabled:opacity-50"
          value={blockValue}
          disabled={disabled}
          onChange={(event) => setBlock(event.target.value)}
          title="段落样式"
        >
          <option value="paragraph">正文</option>
          <option value="heading-1">标题 1</option>
          <option value="heading-2">标题 2</option>
          <option value="heading-3">标题 3</option>
        </select>

        <ToolbarDivider />
        <EditorToolbarButton
          title="撤销"
          disabled={!canRun((current) => current.can().chain().focus().undo().run())}
          onClick={() => run((current) => current.chain().focus().undo().run())}
        >
          <Undo2 className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="重做"
          disabled={!canRun((current) => current.can().chain().focus().redo().run())}
          onClick={() => run((current) => current.chain().focus().redo().run())}
        >
          <Redo2 className="h-4 w-4" />
        </EditorToolbarButton>

        <ToolbarDivider />
        <EditorToolbarButton
          title="加粗"
          active={Boolean(editor?.isActive("bold"))}
          disabled={!canRun((current) => current.can().chain().focus().toggleBold().run())}
          onClick={() => run((current) => current.chain().focus().toggleBold().run())}
        >
          <Bold className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="斜体"
          active={Boolean(editor?.isActive("italic"))}
          disabled={!canRun((current) => current.can().chain().focus().toggleItalic().run())}
          onClick={() => run((current) => current.chain().focus().toggleItalic().run())}
        >
          <Italic className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="删除线"
          active={Boolean(editor?.isActive("strike"))}
          disabled={!canRun((current) => current.can().chain().focus().toggleStrike().run())}
          onClick={() => run((current) => current.chain().focus().toggleStrike().run())}
        >
          <Strikethrough className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="行内代码"
          active={Boolean(editor?.isActive("code"))}
          disabled={!canRun((current) => current.can().chain().focus().toggleCode().run())}
          onClick={() => run((current) => current.chain().focus().toggleCode().run())}
        >
          <Code2 className="h-4 w-4" />
        </EditorToolbarButton>

        <ToolbarDivider />
        <EditorToolbarButton
          title="无序列表"
          active={Boolean(editor?.isActive("bulletList"))}
          disabled={disabled}
          onClick={() => run((current) => current.chain().focus().toggleBulletList().run())}
        >
          <List className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="有序列表"
          active={Boolean(editor?.isActive("orderedList"))}
          disabled={disabled}
          onClick={() => run((current) => current.chain().focus().toggleOrderedList().run())}
        >
          <ListOrdered className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="引用"
          active={Boolean(editor?.isActive("blockquote"))}
          disabled={disabled}
          onClick={() => run((current) => current.chain().focus().toggleBlockquote().run())}
        >
          <Quote className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="代码块"
          active={Boolean(editor?.isActive("codeBlock"))}
          disabled={disabled}
          onClick={() => run((current) => current.chain().focus().toggleCodeBlock().run())}
        >
          <SquareCode className="h-4 w-4" />
        </EditorToolbarButton>
        <EditorToolbarButton
          title="分割线"
          disabled={disabled}
          onClick={() => run((current) => current.chain().focus().setHorizontalRule().run())}
        >
          <Minus className="h-4 w-4" />
        </EditorToolbarButton>
      </div>
    </div>
  );
};

const EditorToolbarButton = ({
  active = false,
  children,
  disabled = false,
  onClick,
  title,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) => (
  <button
    className={cn(
      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-emerald-900 transition disabled:pointer-events-none disabled:opacity-40",
      active
        ? "border-emerald-300 bg-emerald-100 text-emerald-950"
        : "border-transparent bg-white/70 hover:border-emerald-200 hover:bg-white"
    )}
    type="button"
    title={title}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
  >
    {children}
  </button>
);

const ToolbarDivider = () => <div className="h-6 w-px shrink-0 bg-emerald-100" />;

const MobileEditorActionsSheet = ({
  readOnly,
  onClose,
  onDelete,
  onOpenHistory,
  onPermanentDelete,
  onRestore,
}: {
  readOnly: boolean;
  onClose: () => void;
  onDelete: () => void;
  onOpenHistory: () => void;
  onPermanentDelete: () => void;
  onRestore: () => void;
}) => (
  <div className="fixed inset-0 z-50 bg-slate-950/25 lg:hidden" onClick={onClose}>
    <section
      className="absolute inset-x-0 bottom-0 overflow-hidden rounded-t-md border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(15,23,42,0.16)]"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex justify-center py-2">
        <div className="h-1 w-10 rounded-full bg-slate-300" />
      </div>
      <header className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
        <div className="text-base font-semibold text-slate-950">笔记操作</div>
        <Button size="icon" variant="ghost" title="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="p-2">
        <button
          className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50"
          type="button"
          onClick={onOpenHistory}
        >
          <History className="h-5 w-5 text-slate-500" />
          <span className="min-w-0 flex-1 truncate text-base">版本历史</span>
        </button>
        {readOnly ? (
          <>
            <button
              className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-slate-800 transition hover:bg-slate-50"
              type="button"
              onClick={onRestore}
            >
              <RotateCcw className="h-5 w-5 text-slate-500" />
              <span className="min-w-0 flex-1 truncate text-base">恢复笔记</span>
            </button>
            <button
              className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-rose-700 transition hover:bg-rose-50"
              type="button"
              onClick={onPermanentDelete}
            >
              <Trash2 className="h-5 w-5" />
              <span className="min-w-0 flex-1 truncate text-base">彻底删除</span>
            </button>
          </>
        ) : (
          <button
            className="flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-rose-700 transition hover:bg-rose-50"
            type="button"
            onClick={onDelete}
          >
            <Trash2 className="h-5 w-5" />
            <span className="min-w-0 flex-1 truncate text-base">删除笔记</span>
          </button>
        )}
      </div>
    </section>
  </div>
);

const getActiveBlockValue = (editor: Editor | null) => {
  if (!editor) {
    return "paragraph";
  }

  if (editor.isActive("heading", { level: 1 })) {
    return "heading-1";
  }

  if (editor.isActive("heading", { level: 2 })) {
    return "heading-2";
  }

  if (editor.isActive("heading", { level: 3 })) {
    return "heading-3";
  }

  return "paragraph";
};

const EditorPane = ({
  memo,
  isTrashView,
  notebooks,
  isLoading,
  imageCompressionEnabled,
  hasNextMemo,
  hasPreviousMemo,
  onBackToList,
  onOpenNextMemo,
  onOpenPreviousMemo,
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
  hasNextMemo: boolean;
  hasPreviousMemo: boolean;
  onBackToList: () => void;
  onOpenNextMemo: () => void;
  onOpenPreviousMemo: () => void;
  onSaved: (memo: MemoDetail) => Promise<void>;
  onDeleted: (memoId: string) => Promise<void>;
  onPermanentDeleted: (memoId: string) => Promise<void>;
  onRestored: (memoId: string) => Promise<void>;
}) => {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "queued" | "error" | "conflict">("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [, setEditorStateVersion] = useState(0);
  const [imageUploadState, setImageUploadState] = useState<"idle" | "compressing" | "uploading" | "error">("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editorActionsOpen, setEditorActionsOpen] = useState(false);
  const [mobileNotebookSheetOpen, setMobileNotebookSheetOpen] = useState(false);
  const [notebookUpdatePending, setNotebookUpdatePending] = useState(false);
  const notebookOptions = useMemo(() => getNotebookMoveOptions(notebooks), [notebooks]);
  const memoRef = useRef<MemoDetail | null>(memo);
  const editorRef = useRef<Editor | null>(null);
  const editorActionsRef = useDismissableLayer<HTMLDivElement>(editorActionsOpen, () => setEditorActionsOpen(false));
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
        placeholder: "开始记录...",
      }),
    ],
    content: memo?.contentJson ?? { type: "doc", content: [{ type: "paragraph" }] },
    editable: Boolean(memo && !memo.isDeleted && !isTrashView),
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

  useEffect(() => {
    if (!editor) {
      return;
    }

    const refreshToolbar = () => setEditorStateVersion((version) => version + 1);

    editor.on("selectionUpdate", refreshToolbar);
    editor.on("transaction", refreshToolbar);

    return () => {
      editor.off("selectionUpdate", refreshToolbar);
      editor.off("transaction", refreshToolbar);
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
    let cancelled = false;

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
    currentEditor?.setEditable(!memo.isDeleted && !isTrashView);

    if (sameMemo && hasUnsavedChangesRef.current && !memo.isDeleted) {
      return;
    }

    void (async () => {
      const [draft, queuedUpdate] = memo.isDeleted
        ? [null, null]
        : await Promise.all([
            localDb.drafts.get(memo.id),
            localDb.syncQueue.get(getMemoUpdateQueueId(memo.id)),
          ]);

      if (cancelled) {
        return;
      }

      const draftUpdatedAt = draft ? Date.parse(draft.updatedAt) : 0;
      const remoteUpdatedAt = Date.parse(memo.updatedAt);
      const useDraft = Boolean(draft && (queuedUpdate || draftUpdatedAt >= remoteUpdatedAt));
      const nextTitle = useDraft && draft ? draft.title : memo.title ?? "";
      const nextTagsText = useDraft && draft ? draft.tagsText : memo.tags.join(", ");
      const nextContent = useDraft && draft ? draft.contentJson : memo.contentJson;
      const nextHasUnsavedChanges = Boolean(useDraft && !queuedUpdate);

      hydratingRef.current = true;
      editingMemoIdRef.current = memo.id;
      hasUnsavedChangesRef.current = nextHasUnsavedChanges;
      setHasUnsavedChanges(nextHasUnsavedChanges);
      setSaveState(queuedUpdate ? syncStatusToSaveState(queuedUpdate.status) : "idle");
      setTitle(nextTitle);
      setTagsText(nextTagsText);

      if (currentEditor) {
        currentEditor.commands.setContent(nextContent);
      }

      window.setTimeout(() => {
        hydratingRef.current = false;
      }, 0);
    })();

    return () => {
      cancelled = true;
    };
  }, [isTrashView, memo, editor]);

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

      const contentJson = currentEditor.getJSON() as TiptapDoc;
      const payload: MemoUpdateSyncPayload = {
        memoId: currentMemo.id,
        expectedRevision: currentMemo.revision,
        title,
        contentJson,
        tags: parseTagsText(tagsText),
      };
      let data;

      try {
        data = await api.updateMemo(currentMemo.id, {
          expectedRevision: payload.expectedRevision,
          title: payload.title,
          contentJson: payload.contentJson,
          tags: payload.tags,
        });
      } catch (error) {
        throw new MemoSaveRequestError(error, payload, tagsText);
      }

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
    onError: async (error) => {
      const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;
      const code =
        sourceError && typeof sourceError === "object" && "code" in sourceError
          ? String(sourceError.code)
          : null;

      if (code === "revision_conflict") {
        setSaveState("conflict");
        return;
      }

      if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
        await queueMemoUpdate(error.payload);
        await localDb.drafts.put({
          memoId: error.payload.memoId,
          title: error.payload.title,
          tagsText: error.tagsText,
          contentJson: error.payload.contentJson,
          updatedAt: new Date().toISOString(),
        });

        hasUnsavedChangesRef.current = false;
        setHasUnsavedChanges(false);
        setSaveState("queued");
        return;
      }

      setSaveState("error");
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
          <div className="text-sm font-medium text-slate-700">选择或新建一条笔记</div>
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
        : saveState === "queued"
          ? "待同步"
          : saveState === "conflict"
            ? "有冲突"
            : saveState === "error"
              ? "保存失败"
              : hasUnsavedChanges
                ? "未保存"
                : "已保存";
  const saveStateClassName =
    saveState === "error" || saveState === "conflict"
      ? "bg-rose-50 text-rose-700"
      : saveState === "queued"
        ? "bg-amber-50 text-amber-700"
        : saveState === "saving" || hasUnsavedChanges
          ? "bg-emerald-50 text-emerald-700"
          : "bg-slate-100 text-slate-500";
  const imageUploadLabel =
    imageUploadState === "error"
      ? "图片失败"
      : imageUploadState === "compressing"
        ? "压缩中"
        : imageUploadState === "uploading"
          ? "上传中"
          : null;
  const mobileStatusLabel = imageUploadLabel ?? saveLabel;
  const mobileStatusClassName =
    imageUploadState === "error"
      ? "bg-rose-50 text-rose-700"
      : imageUploadState !== "idle"
        ? "bg-emerald-50 text-emerald-700"
        : saveStateClassName;
  const updatedLabel = formatDateTime(memo.updatedAt);
  const currentNotebookLabel = notebookOptions.find((notebook) => notebook.id === memo.notebookId)?.name ?? "笔记本";
  const mobileDoneDisabled =
    saveMutation.isPending ||
    notebookUpdatePending ||
    imageUploadState === "compressing" ||
    imageUploadState === "uploading";
  const updateMemoNotebook = (notebookId: string, sourceMemo: MemoDetail = memoRef.current ?? memo) => {
    if (readOnly || notebookId === sourceMemo.notebookId || notebookUpdatePending) {
      setMobileNotebookSheetOpen(false);
      return;
    }

    setNotebookUpdatePending(true);
    setSaveState("saving");

    void api
      .updateMemo(sourceMemo.id, {
        expectedRevision: sourceMemo.revision,
        notebookId,
      })
      .then(async (data) => {
        memoRef.current = data.memo;
        await onSaved(data.memo);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1200);
      })
      .catch(() => setSaveState("error"))
      .finally(() => {
        setNotebookUpdatePending(false);
        setMobileNotebookSheetOpen(false);
      });
  };
  const handleNotebookChange = (notebookId: string) => {
    if (!hasUnsavedChanges || saveMutation.isPending) {
      updateMemoNotebook(notebookId);
      return;
    }

    saveMutation.mutate(undefined, {
      onSuccess: ({ memo: savedMemo }) => updateMemoNotebook(notebookId, savedMemo),
    });
  };
  const handleMobileDone = () => {
    if (readOnly || !editor || !hasUnsavedChanges) {
      onBackToList();
      return;
    }

    saveMutation.mutate(undefined, {
      onSuccess: () => onBackToList(),
      onError: (error) => {
        const sourceError = error instanceof MemoSaveRequestError ? error.originalError : error;

        if (error instanceof MemoSaveRequestError && shouldQueueMemoSaveError(sourceError)) {
          onBackToList();
        }
      },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="shrink-0 border-b border-emerald-100 bg-white">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 sm:px-5">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Button className="lg:hidden" size="icon" variant="ghost" title="返回列表" onClick={onBackToList}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="hidden items-center gap-1 sm:flex lg:hidden">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-30"
                type="button"
                title="上一条笔记"
                disabled={!hasPreviousMemo}
                onClick={onOpenPreviousMemo}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-30"
                type="button"
                title="下一条笔记"
                disabled={!hasNextMemo}
                onClick={onOpenNextMemo}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="hidden items-center gap-1 lg:flex">
              <Button size="icon" variant="ghost" title="上一条笔记" onClick={onOpenPreviousMemo} disabled={!hasPreviousMemo}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" title="下一条笔记" onClick={onOpenNextMemo} disabled={!hasNextMemo}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <button
              className="flex h-8 min-w-0 max-w-[112px] items-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-xs font-medium text-slate-700 outline-none transition hover:border-emerald-100 hover:bg-emerald-50/70 disabled:opacity-50 sm:hidden"
              type="button"
              disabled={readOnly || notebookUpdatePending}
              title="所在笔记本"
              onClick={() => setMobileNotebookSheetOpen(true)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{currentNotebookLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            </button>
            <select
              value={memo.notebookId}
              className="hidden h-8 min-w-0 max-w-[260px] rounded-md border border-transparent bg-transparent px-2 text-xs font-medium text-slate-700 outline-none hover:border-emerald-100 hover:bg-emerald-50/70 sm:block"
              disabled={readOnly || notebookUpdatePending}
              onChange={(event) => handleNotebookChange(event.target.value)}
              title="所在笔记本"
            >
              {notebookOptions.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.selectLabel}
                </option>
              ))}
            </select>
            <span className="hidden truncate text-xs text-slate-400 sm:inline">
              更新于 {updatedLabel}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {imageUploadState !== "idle" ? (
              <span
                className={cn(
                  "hidden rounded-md px-2 py-1 text-xs font-medium md:inline-flex",
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
            <span className={cn("hidden rounded-md px-2 py-1 text-xs font-medium sm:inline-flex", saveStateClassName)}>
              {saveLabel}
            </span>
            <span className={cn("inline-flex max-w-[4rem] truncate rounded-full px-2 py-1 text-[11px] font-medium sm:hidden", mobileStatusClassName)}>
              {mobileStatusLabel}
            </span>
            <button
              className="inline-flex h-8 items-center justify-center rounded-full bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 sm:hidden"
              type="button"
              disabled={mobileDoneDisabled}
              onClick={handleMobileDone}
            >
              {saveMutation.isPending ? "保存中" : "完成"}
            </button>
            <Button className="hidden sm:inline-flex" size="icon" variant="ghost" title="版本历史" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
            </Button>
            {!readOnly ? (
              <Button
                className="hidden sm:inline-flex"
                size="icon"
                variant="solid"
                title="保存"
                onClick={() => saveMutation.mutate()}
                disabled={!editor || saveMutation.isPending || !hasUnsavedChanges}
              >
                <Save className="h-4 w-4" />
              </Button>
            ) : null}
            <div className="relative" ref={editorActionsRef}>
              <Button
                size="icon"
                variant="ghost"
                title="更多"
                onClick={() => setEditorActionsOpen((value) => !value)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {editorActionsOpen ? (
                <div className="absolute right-0 top-9 z-30 hidden w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-panel lg:block">
                  <button
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => {
                      setEditorActionsOpen(false);
                      setHistoryOpen(true);
                    }}
                  >
                    <History className="h-4 w-4" />
                    版本历史
                  </button>
                  {readOnly ? (
                    <>
                      <button
                        className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                        type="button"
                        onClick={() => {
                          setEditorActionsOpen(false);
                          void onRestored(memo.id);
                        }}
                      >
                        <RotateCcw className="h-4 w-4" />
                        恢复笔记
                      </button>
                      <button
                        className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                        type="button"
                        onClick={() => {
                          setEditorActionsOpen(false);
                          if (window.confirm("彻底删除后无法恢复，确认继续吗？")) {
                            void onPermanentDeleted(memo.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        彻底删除
                      </button>
                    </>
                  ) : (
                    <button
                      className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-rose-700 transition hover:bg-rose-50"
                      type="button"
                      onClick={() => {
                        setEditorActionsOpen(false);
                        void onDeleted(memo.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除笔记
                    </button>
                  )}
                </div>
              ) : null}
              {editorActionsOpen ? (
                <MobileEditorActionsSheet
                  readOnly={readOnly}
                  onClose={() => setEditorActionsOpen(false)}
                  onOpenHistory={() => {
                    setEditorActionsOpen(false);
                    setHistoryOpen(true);
                  }}
                  onRestore={() => {
                    setEditorActionsOpen(false);
                    void onRestored(memo.id);
                  }}
                  onPermanentDelete={() => {
                    setEditorActionsOpen(false);
                    if (window.confirm("彻底删除后无法恢复，确认继续吗？")) {
                      void onPermanentDeleted(memo.id);
                    }
                  }}
                  onDelete={() => {
                    setEditorActionsOpen(false);
                    void onDeleted(memo.id);
                  }}
                />
              ) : null}
            </div>
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
            placeholder={DEFAULT_MEMO_TITLE}
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
              placeholder="添加标签，用逗号分隔"
            />
          </label>
        </div>
        <EditorToolbar editor={editor} readOnly={readOnly} />
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
      {mobileNotebookSheetOpen ? (
        <MobileNotebookSelectSheet
          isUpdating={notebookUpdatePending || saveMutation.isPending}
          options={notebookOptions}
          selectedNotebookId={memo.notebookId}
          onClose={() => setMobileNotebookSheetOpen(false)}
          onSelect={handleNotebookChange}
        />
      ) : null}
    </div>
  );
};
