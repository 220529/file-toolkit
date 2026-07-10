import { lazy, Suspense, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardTitle } from "./components/ui/card";
import { Icon, type IconName } from "./components/ui/icon";
import { Modal } from "./components/ui/modal";
import { Tooltip, TooltipProvider } from "./components/ui/tooltip";
import { TaskCenterProvider, TaskStatusBar, useTaskCenter } from "./components/TaskCenter";
import { ToastProvider } from "./components/Toast";
import LogViewer from "./components/LogViewer";
import { cn } from "./utils/cn";
import "./index.css";

const FileStats = lazy(() => import("./pages/FileStats"));
const FileOrganize = lazy(() => import("./pages/FileOrganize"));
const BatchRename = lazy(() => import("./pages/BatchRename"));
const Dedup = lazy(() => import("./pages/Dedup"));
const VideoCut = lazy(() => import("./pages/VideoCut"));
const BatchVideoTrim = lazy(() => import("./pages/BatchVideoTrim"));
const VideoConvert = lazy(() => import("./pages/VideoConvert"));
const Watermark = lazy(() => import("./pages/Watermark"));

type Tab = "stats" | "file-organize" | "batch-rename" | "dedup" | "video-cut" | "batch-video-trim" | "video-convert" | "watermark";
type ResetMode = "current" | "all";

const tabMeta: Record<Tab, { label: string; icon: IconName; section: string }> = {
  stats: { label: "文件统计", icon: "stats", section: "文件" },
  "file-organize": { label: "文件归类", icon: "folder", section: "文件" },
  "batch-rename": { label: "批量重命名", icon: "file", section: "文件" },
  dedup: { label: "文件去重", icon: "duplicate", section: "文件" },
  "video-cut": { label: "视频截取", icon: "scissors", section: "视频" },
  "batch-video-trim": { label: "批量去头", icon: "batch", section: "视频" },
  "video-convert": { label: "格式转换", icon: "convert", section: "视频" },
  watermark: { label: "水印处理", icon: "magic", section: "图像" },
};

const tabSections: Array<{ title: string; tabs: Tab[] }> = [
  { title: "文件", tabs: ["stats", "file-organize", "batch-rename", "dedup"] },
  { title: "视频", tabs: ["video-cut", "batch-video-trim", "video-convert"] },
  { title: "图像", tabs: ["watermark"] },
];

const initialResetVersions: Record<Tab, number> = {
  stats: 0,
  "file-organize": 0,
  "batch-rename": 0,
  dedup: 0,
  "video-cut": 0,
  "batch-video-trim": 0,
  "video-convert": 0,
  watermark: 0,
};

const taskIdsByTab: Record<Tab, string> = {
  stats: "file-stats",
  "file-organize": "file-organize",
  "batch-rename": "batch-rename",
  dedup: "dedup",
  "video-cut": "video-cut",
  "batch-video-trim": "batch-video-trim",
  "video-convert": "video-convert",
  watermark: "watermark",
};

interface SidebarTool {
  label: string;
  shortLabel: string;
  expandedLabel: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
}

const AUTO_COLLAPSE_WIDTH = 920;

function PageFallback() {
  return (
    <div className="flex min-h-[280px] items-center justify-center text-sm text-slate-500">
      <div className="flex items-center gap-2">
        <Icon name="reset" size={16} className="animate-spin" />
        加载中
      </div>
    </div>
  );
}

function PageSlot({
  active,
  visited,
  children,
}: {
  active: boolean;
  visited: boolean;
  children: React.ReactNode;
}) {
  const shouldRender = active || visited;

  return (
    <div className={active ? "" : "hidden"}>
      {shouldRender && <Suspense fallback={<PageFallback />}>{children}</Suspense>}
    </div>
  );
}

function AppShell() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(["stats"]));
  const [collapsed, setCollapsed] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < AUTO_COLLAPSE_WIDTH
  );
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [resetMode, setResetMode] = useState<ResetMode | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [resetVersions, setResetVersions] = useState<Record<Tab, number>>(initialResetVersions);
  const [version, setVersion] = useState("0.0.0");
  const { tasks } = useTaskCenter();

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    function syncSidebarWidth() {
      if (window.innerWidth < AUTO_COLLAPSE_WIDTH) {
        setCollapsed(true);
        return;
      }
      setCollapsed(sidebarPreference ?? false);
    }

    syncSidebarWidth();
    window.addEventListener("resize", syncSidebarWidth);
    return () => window.removeEventListener("resize", syncSidebarWidth);
  }, [sidebarPreference]);

  useEffect(() => {
    setVisitedTabs((current) => {
      if (current.has(activeTab)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  const activeMeta = tabMeta[activeTab];
  const anyTaskRunning = tasks.some((task) => task.status === "running");
  const activeTaskRunning = tasks.some(
    (task) => task.id === taskIdsByTab[activeTab] && task.status === "running"
  );
  const resetBlocked = resetMode === "all" ? anyTaskRunning : activeTaskRunning;
  const resetTitle = resetMode === "all" ? "重置全部模块？" : `重置${activeMeta.label}？`;
  const resetDescription =
    resetMode === "all"
      ? anyTaskRunning
        ? "还有任务运行中，请先取消或等待完成后再重置全部模块。"
        : "会清空所有模块的路径、结果、预览和临时设置。"
      : activeTaskRunning
        ? "当前模块还有任务运行中，请先取消或等待完成后再重置。"
        : "会清空当前模块的路径、结果、预览和临时设置，不影响其它模块。";

  function openCurrentResetConfirm() {
    setResetMode("current");
  }

  function openAllResetConfirm() {
    setResetMode("all");
  }

  function handleReset() {
    if (!resetMode || resetBlocked) return;

    setResetVersions((current) => {
      if (resetMode === "all") {
        return Object.fromEntries(
          (Object.keys(current) as Tab[]).map((tab) => [tab, current[tab] + 1])
        ) as Record<Tab, number>;
      }

      return {
        ...current,
        [activeTab]: current[activeTab] + 1,
      };
    });
    setResetMode(null);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-main-scroll='true']")?.scrollTo({ top: 0 });
    });
  }

  const sidebarTools: SidebarTool[] = [
    {
      label: anyTaskRunning ? "还有任务运行中，暂不能重置全部模块" : "重置全部模块",
      shortLabel: "重置",
      expandedLabel: "重置全部",
      icon: "reset",
      onClick: openAllResetConfirm,
      disabled: anyTaskRunning,
    },
    { label: "查看日志", shortLabel: "日志", expandedLabel: "日志", icon: "logs", onClick: () => setShowLogs(true) },
    { label: "关于小文喵", shortLabel: "关于", expandedLabel: "关于", icon: "info", onClick: () => setShowAbout(true) },
  ];

  return (
    <div className="h-screen overflow-hidden bg-[var(--canvas)] text-[var(--text-strong)]">
          <div className="relative flex h-full overflow-hidden bg-[var(--panel)]">
            <aside
              className={cn(
                "app-sidebar relative z-10 flex h-full flex-col border-r border-[var(--nav-stroke)] bg-[var(--nav-bg)] px-2 py-3 text-white transition-all duration-300",
                collapsed ? "w-[56px]" : "w-[184px]"
              )}
            >
              <div
                className={cn(
                  "app-sidebar-brand mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--nav-stroke)] bg-[var(--nav-bg-raised)] p-1.5",
                  collapsed && "flex-col justify-center"
                )}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-[7px] bg-white text-[var(--brand-700)]">
                  <Icon name="app" size={18} />
                </div>
                {!collapsed && (
                  <div className="app-sidebar-brand-text min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-white">小文喵</div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--nav-muted)]">File Toolkit · v{version}</div>
                  </div>
                )}
              </div>

              <Tooltip content={collapsed ? "展开导航" : "收起导航"} side="right">
                <button
                  className={cn(
                    "absolute right-[-12px] top-1/2 z-20 flex h-11 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--stroke)] bg-white text-[var(--text-muted)] shadow-[0_8px_18px_rgba(16,20,23,0.16)] transition hover:text-[var(--brand-700)]",
                    collapsed && "right-[-11px]"
                  )}
                  onClick={() => {
                    setCollapsed((value) => {
                      const next = !value;
                      setSidebarPreference(next);
                      return next;
                    });
                  }}
                  aria-label={collapsed ? "展开导航" : "收起导航"}
                >
                  <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} />
                </button>
              </Tooltip>

              <nav className="flex-1 space-y-3">
                {tabSections.map((section) => (
                  <div key={section.title} className="space-y-1">
                    {!collapsed && (
                      <div className="app-sidebar-section-title px-2 pt-1 text-[11px] font-medium text-[var(--nav-muted)]">{section.title}</div>
                    )}
                    {section.tabs.map((tab) => {
                      const item = tabMeta[tab];
                      const active = activeTab === tab;
                      const navButton = (
                        <button
                          key={tab}
                          onClick={() => {
                            setActiveTab(tab);
                          }}
                          aria-label={item.label}
                          className={cn(
                            "app-sidebar-item group flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left transition-colors duration-150",
                            active
                              ? "bg-[var(--brand-500)] text-white"
                              : "text-[#d7dee4] hover:bg-white/[0.08] hover:text-white",
                            collapsed && "justify-center px-0"
                          )}
                        >
                          <div
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-[7px] transition-colors",
                              active ? "bg-white/15 text-white" : "bg-white/[0.06] text-[#aeb9c0]"
                            )}
                          >
                            <Icon name={item.icon} size={16} />
                          </div>
                          {!collapsed && <div className="app-sidebar-label min-w-0 truncate text-[13px] font-medium">{item.label}</div>}
                        </button>
                      );
                      return collapsed ? (
                        <Tooltip key={tab} content={item.label} side="right">
                          {navButton}
                        </Tooltip>
                      ) : (
                        navButton
                      );
                    })}
                  </div>
                ))}
              </nav>

              <div
                className={cn(
                  "app-sidebar-tools mt-3 border-t border-[var(--nav-stroke)] pt-3",
                  collapsed ? "flex flex-col items-center gap-2" : "space-y-2"
                )}
              >
                {collapsed ? (
                  sidebarTools.map((tool) => (
                    <Tooltip key={tool.shortLabel} content={tool.label} side="right">
                      <button
                        className={cn(
                          "group flex h-9 w-9 items-center justify-center rounded-[8px] border transition",
                          "border-[var(--nav-stroke)] bg-white/[0.06] text-[#d7dee4] hover:border-white/[0.18] hover:bg-white/[0.10] hover:text-white",
                          tool.disabled && "cursor-not-allowed opacity-45 hover:border-[var(--nav-stroke)] hover:bg-white/[0.06] hover:text-[#d7dee4]"
                        )}
                        aria-label={tool.label}
                        onClick={tool.onClick}
                        disabled={tool.disabled}
                      >
                        <Icon name={tool.icon} size={15} />
                      </button>
                    </Tooltip>
                  ))
                ) : (
                  <>
                    <Tooltip content={sidebarTools[0].label} side="top">
                      <button
                        className={cn(
                          "group flex h-9 w-full min-w-0 items-center justify-center gap-1.5 rounded-[8px] border px-2 transition",
                          "border-[var(--nav-stroke)] bg-white/[0.06] text-[#d7dee4] hover:border-white/[0.18] hover:bg-white/[0.10] hover:text-white",
                          sidebarTools[0].disabled && "cursor-not-allowed opacity-45 hover:border-[var(--nav-stroke)] hover:bg-white/[0.06] hover:text-[#d7dee4]"
                        )}
                        aria-label={sidebarTools[0].label}
                        onClick={sidebarTools[0].onClick}
                        disabled={sidebarTools[0].disabled}
                      >
                        <Icon name={sidebarTools[0].icon} size={15} />
                        <span className="app-sidebar-tools-label truncate text-[12px] font-medium">{sidebarTools[0].expandedLabel}</span>
                      </button>
                    </Tooltip>
                    <div className="grid grid-cols-2 gap-2">
                      {sidebarTools.slice(1).map((tool) => (
                        <Tooltip key={tool.shortLabel} content={tool.label} side="top">
                          <button
                            className="group flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[8px] border border-[var(--nav-stroke)] bg-white/[0.06] px-2 text-[#d7dee4] transition hover:border-white/[0.18] hover:bg-white/[0.10] hover:text-white"
                            aria-label={tool.label}
                            onClick={tool.onClick}
                          >
                            <Icon name={tool.icon} size={15} />
                            <span className="app-sidebar-tools-label truncate text-[12px] font-medium">{tool.expandedLabel}</span>
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </aside>

            <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-[64px] shrink-0 items-center justify-between border-b border-[var(--stroke)] bg-white px-6">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-[17px] font-semibold text-[var(--text-strong)]">{activeMeta.label}</div>
                      <Badge tone="default">{activeMeta.section}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">本地处理 · 可预览 · 可核对</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={openCurrentResetConfirm} disabled={activeTaskRunning}>
                    <Icon name="reset" size={14} />
                    重置当前
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowLogs(true)}>
                    <Icon name="logs" size={14} />
                    日志
                  </Button>
                </div>
              </div>
              <TaskStatusBar />
              <div className="flex-1 overflow-auto bg-[var(--panel)] px-5 py-4" data-main-scroll="true">
                <PageSlot active={activeTab === "stats"} visited={visitedTabs.has("stats")}>
                  <FileStats key={`stats-${resetVersions.stats}`} active={activeTab === "stats"} />
                </PageSlot>
                <PageSlot active={activeTab === "file-organize"} visited={visitedTabs.has("file-organize")}>
                  <FileOrganize key={`organize-${resetVersions["file-organize"]}`} active={activeTab === "file-organize"} />
                </PageSlot>
                <PageSlot active={activeTab === "batch-rename"} visited={visitedTabs.has("batch-rename")}>
                  <BatchRename key={`rename-${resetVersions["batch-rename"]}`} active={activeTab === "batch-rename"} />
                </PageSlot>
                <PageSlot active={activeTab === "dedup"} visited={visitedTabs.has("dedup")}>
                  <Dedup key={`dedup-${resetVersions.dedup}`} active={activeTab === "dedup"} />
                </PageSlot>
                <PageSlot active={activeTab === "video-cut"} visited={visitedTabs.has("video-cut")}>
                  <VideoCut key={`video-${resetVersions["video-cut"]}`} active={activeTab === "video-cut"} />
                </PageSlot>
                <PageSlot active={activeTab === "batch-video-trim"} visited={visitedTabs.has("batch-video-trim")}>
                  <BatchVideoTrim key={`batch-video-${resetVersions["batch-video-trim"]}`} active={activeTab === "batch-video-trim"} />
                </PageSlot>
                <PageSlot active={activeTab === "video-convert"} visited={visitedTabs.has("video-convert")}>
                  <VideoConvert key={`convert-${resetVersions["video-convert"]}`} active={activeTab === "video-convert"} />
                </PageSlot>
                <PageSlot active={activeTab === "watermark"} visited={visitedTabs.has("watermark")}>
                  <Watermark key={`watermark-${resetVersions.watermark}`} active={activeTab === "watermark"} />
                </PageSlot>
              </div>
            </main>
          </div>

          <Modal
            open={resetMode !== null}
            onClose={() => setResetMode(null)}
            accessibleTitle={resetMode === "all" ? "重置全部模块" : `重置${activeMeta.label}`}
            className="max-w-md"
          >
            <div className="space-y-5 p-6">
              <div>
                <CardTitle className="text-xl">{resetTitle}</CardTitle>
                <div className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{resetDescription}</div>
              </div>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setResetMode(null)}>
                  取消
                </Button>
                <Button variant="primary" onClick={handleReset} disabled={resetBlocked}>
                  确认重置
                </Button>
              </div>
            </div>
          </Modal>

          <Modal open={showAbout} onClose={() => setShowAbout(false)} accessibleTitle="关于小文喵" className="max-w-xl">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="text-xl font-semibold">小文喵</div>
                  </div>
                </div>
                <Badge tone="info">v{version}</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Card>
                  <CardContent className="px-4 py-4">
                    <div className="text-xs font-medium text-slate-400">技术栈</div>
                    <div className="mt-2 text-sm font-medium text-slate-800">Tauri + React + Rust</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="px-4 py-4">
                    <div className="text-xs font-medium text-slate-400">设计目标</div>
                    <div className="mt-2 text-sm font-medium text-slate-800">快反馈、低惊扰、可核对</div>
                  </CardContent>
                </Card>
              </div>
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setShowAbout(false)}>
                  关闭
                </Button>
              </div>
            </div>
          </Modal>

      {showLogs && <LogViewer onClose={() => setShowLogs(false)} />}
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <TooltipProvider delayDuration={300}>
        <TaskCenterProvider>
          <AppShell />
        </TaskCenterProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

export default App;
