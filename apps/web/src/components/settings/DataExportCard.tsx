import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, DatabaseBackup, Download, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import {
  createEdgeEverZip,
  downloadEdgeEverZip,
  parseEdgeEverZip,
  restoreEdgeEverZip,
  type EdgeEverZipProgress,
  type ParsedEdgeEverZip,
} from "@/lib/json-backup";

type OperationState = "idle" | "working" | "complete" | "error";
type OperationKind = "export" | "import";

const Progress = ({ progress }: { progress: EdgeEverZipProgress }) => {
  const percentage = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-emerald-600 transition-[width]" style={{ width: `${percentage}%` }} />
    </div>
  );
};

export const DataExportCard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<OperationState>("idle");
  const [operation, setOperation] = useState<OperationKind>("export");
  const [progress, setProgress] = useState<EdgeEverZipProgress>({ completed: 0, total: 0 });
  const [pendingImport, setPendingImport] = useState<ParsedEdgeEverZip | null>(null);

  const busy = state === "working";

  const handleExport = async () => {
    setOperation("export");
    setState("working");
    setProgress({ completed: 0, total: 0 });
    try {
      const blob = await createEdgeEverZip(
        { listNotebooks: api.listNotebooks, getPage: api.getJsonBackupPage, getResourceBlob: api.getResourceBlob },
        { edgeeverVersion: __EDGEEVER_APP_VERSION__, buildId: __EDGEEVER_BUILD_ID__ },
        setProgress
      );
      downloadEdgeEverZip(blob);
      setState("complete");
    } catch (error) {
      console.error("Failed to export EdgeEver ZIP", error);
      setState("error");
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setOperation("import");
    setState("working");
    setProgress({ completed: 0, total: 0 });
    try {
      const parsed = await parseEdgeEverZip(file);
      setPendingImport(parsed);
      setState("idle");
    } catch (error) {
      console.error("Invalid EdgeEver ZIP", error);
      setState("error");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleConfirmImport = async () => {
    if (!pendingImport) return;
    const archive = pendingImport;
    setPendingImport(null);
    setOperation("import");
    setState("working");
    setProgress({ completed: 0, total: 0 });
    try {
      await restoreEdgeEverZip(
        archive,
        {
          restoreNotebooks: api.restoreJsonNotebooks,
          restoreMemos: api.restoreJsonMemos,
          restoreResource: api.restoreJsonResource,
        },
        setProgress
      );
      await queryClient.invalidateQueries();
      setState("complete");
    } catch (error) {
      console.error("Failed to import EdgeEver ZIP", error);
      setState("error");
    }
  };

  return (
    <>
      <Card className="w-full min-w-0 overflow-hidden shadow-none">
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <DatabaseBackup className="h-4 w-4 text-emerald-700" />
            {t("dataExport.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 pt-0">
          <div className="grid gap-2 rounded-lg border border-slate-200 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="min-w-0">
              <CardDescription className="text-xs leading-5">{t("dataExport.description")}</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />
                {t("dataExport.importButton")}
              </Button>
              <Button size="sm" type="button" disabled={busy} onClick={() => void handleExport()}>
                <Download className="h-4 w-4" />
                {t("dataExport.exportButton")}
              </Button>
              <input ref={fileInputRef} className="hidden" type="file" accept=".zip,application/zip" onChange={(event) => void handleImportFile(event.target.files?.[0])} />
            </div>
          </div>

          {busy ? (
            <div className="grid gap-1.5" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{operation === "import" ? t("dataExport.importing") : t("dataExport.working")}</span>
                <span>{t("dataExport.progress", { completed: progress.completed, total: progress.total })}</span>
              </div>
              <Progress progress={progress} />
            </div>
          ) : null}
          {state === "complete" ? <p className="flex items-center gap-1.5 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />{operation === "import" ? t("dataExport.importComplete") : t("dataExport.complete")}</p> : null}
          {state === "error" ? <p className="flex items-center gap-1.5 text-xs text-red-600" role="alert"><AlertCircle className="h-3.5 w-3.5" />{operation === "import" ? t("dataExport.importError") : t("dataExport.error")}</p> : null}
        </CardContent>
      </Card>

      <Dialog open={Boolean(pendingImport)} onOpenChange={(open) => { if (!open) setPendingImport(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dataExport.importConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("dataExport.importConfirmDescription", {
                memos: pendingImport?.manifest.counts.memos ?? 0,
                resources: pendingImport?.manifest.counts.resources ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setPendingImport(null)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => void handleConfirmImport()}>{t("dataExport.confirmImport")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
