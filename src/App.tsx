import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardTitle } from "./components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Icon, type IconName } from "./components/ui/icon";
import { Modal } from "./components/ui/modal";
import { Tooltip, TooltipProvider } from "./components/ui/tooltip";
import { TaskCenterProvider, TaskStatusBar } from "./components/TaskCenter";
import { ToastProvider } from "./components/Toast";
import LogViewer from "./components/LogViewer";
import Dedup from "./pages/Dedup";
import BatchVideoTrim from "./pages/BatchVideoTrim";
import FileStats from "./pages/FileStats";
import TextToImage from "./pages/TextToImage";
import VideoConvert from "./pages/VideoConvert";
import VideoCut from "./pages/VideoCut";
import Watermark from "./pages/Watermark";
import { cn } from "./utils/cn";
import "./index.css";

type Tab = "stats" | "dedup" | "video-cut" | "batch-video-trim" | "video-convert" | "text-to-image" | "watermark";

const tabMeta: Record<Tab, { label: string; icon: IconName; section: string }> = {
  stats: { label: "文件统计", icon: "stats", section: "文件" },
  dedup: { label: "文件去重", icon: "duplicate", section: "文件" },
  "video-cut": { label: "视频截取", icon: "scissors", section: "视频" },
  "batch-video-trim": { label: "批量去头", icon: "batch", section: "视频" },
  "video-convert": { label: "格式转换", icon: "convert", section: "视频" },
  "text-to-image": { label: "文生图", icon: "image", section: "图像" },
  watermark: { label: "水印处理", icon: "magic", section: "图像" },
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");
  const [collapsed, setCollapsed] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [version, setVersion] = useState("0.0.0");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  function handleReset() {
    setResetKey((current) => current + 1);
    setActiveTab("stats");
    setShowResetConfirm(false);
  }

  const activeMeta = tabMeta[activeTab];

  return (
    <ToastProvider>
      <TooltipProvider delayDuration={300}>
        <TaskCenterProvider>
        <div className="h-screen overflow-hidden p-3 text-slate-900">
          <div className="relative flex h-full overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
            <aside
              className={cn(
                "relative z-10 flex h-full flex-col border-r border-slate-200 bg-[var(--nav-bg)] px-3 py-3 text-slate-800 transition-all duration-300",
                collapsed ? "w-[66px]" : "w-[210px]"
              )}
            >
              <div
                className={cn(
                  "mb-4 flex items-center gap-2 rounded-[10px] border border-transparent p-1.5",
                  collapsed && "flex-col justify-center"
                )}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
                  <Icon name="app" size={20} />
                </div>
                {!collapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-slate-950">小文喵</div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--nav-muted)]">File Toolkit · v{version}</div>
                  </div>
                )}
              </div>

              <Tooltip content={collapsed ? "展开导航" : "收起导航"} side="right">
                <button
                  className={cn(
                    "absolute right-[-12px] top-1/2 z-20 flex h-11 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-[0_2px_6px_rgba(15,23,42,0.12)] transition hover:text-[var(--brand-700)]",
                    collapsed && "right-[-11px]"
                  )}
                  onClick={() => {
                    setCollapsed((value) => !value);
                    setShowToolsMenu(false);
                  }}
                  aria-label={collapsed ? "展开导航" : "收起导航"}
                >
                  <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16} />
                </button>
              </Tooltip>

              <nav className="flex-1 space-y-1">
                {(Object.keys(tabMeta) as Tab[]).map((tab) => {
                  const item = tabMeta[tab];
                  const active = activeTab === tab;
                  const navButton = (
                    <button
                      key={tab}
                      onClick={() => {
                        setActiveTab(tab);
                        setShowToolsMenu(false);
                      }}
                      aria-label={item.label}
                      className={cn(
                        "group relative flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2.5 text-left transition-all duration-200",
                        active
                          ? "bg-[var(--brand-50)] text-[var(--brand-700)] ring-1 ring-blue-100"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
                        collapsed && "justify-center px-0"
                      )}
                    >
                      {active && !collapsed && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-[var(--accent-500)]" />}
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-[8px] transition-all",
                          active ? "bg-white text-[var(--brand-700)] ring-1 ring-blue-100" : "bg-white text-slate-500 ring-1 ring-slate-200"
                        )}
                      >
                        <Icon name={item.icon} size={18} />
                      </div>
                      {!collapsed && (
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{item.label}</div>
                          <div className={cn("mt-0.5 text-[10px]", active ? "text-slate-500" : "text-[var(--nav-muted)]")}>{item.section}</div>
                        </div>
                      )}
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
              </nav>

              <div className="relative mt-4 border-t border-slate-200 pt-4">
                <DropdownMenu open={showToolsMenu} onOpenChange={setShowToolsMenu}>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "group flex w-full items-center justify-center rounded-[8px] border border-slate-200 bg-white px-2.5 py-2.5 text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950",
                        collapsed && "justify-center px-0"
                      )}
                      aria-label="更多工具"
                    >
                      <Icon name="more" size={16} />
                      {!collapsed && <span className="text-[13px] font-medium">更多</span>}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align={collapsed ? "start" : "center"} className={collapsed ? "w-[188px]" : "w-[166px]"}>
                    <DropdownMenuItem onSelect={() => setShowResetConfirm(true)}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-slate-100 text-slate-700">
                        <Icon name="reset" size={16} />
                      </span>
                      <span className="font-medium">重置</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowLogs(true)}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-slate-100 text-slate-700">
                        <Icon name="logs" size={16} />
                      </span>
                      <span className="font-medium">日志</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowAbout(true)}>
                      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-slate-100 text-slate-700">
                        <Icon name="info" size={16} />
                      </span>
                      <span className="font-medium">关于</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </aside>

            <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-[60px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-[var(--brand-600)] text-white">
                    <Icon name={activeMeta.icon} size={18} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-[15px] font-semibold text-slate-950">{activeMeta.label}</div>
                      <Badge tone="default">{activeMeta.section}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">当前工作区</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowLogs(true)}>
                    <Icon name="logs" size={14} />
                    日志
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setShowResetConfirm(true)}>
                    <Icon name="reset" size={14} />
                    重置
                  </Button>
                </div>
              </div>
              <TaskStatusBar />
              <div className="flex-1 overflow-auto bg-[var(--panel)] px-3 py-3" data-main-scroll="true">
                <div className={activeTab === "stats" ? "" : "hidden"}>
                  <FileStats key={`stats-${resetKey}`} active={activeTab === "stats"} />
                </div>
                <div className={activeTab === "dedup" ? "" : "hidden"}>
                  <Dedup key={`dedup-${resetKey}`} active={activeTab === "dedup"} />
                </div>
                <div className={activeTab === "video-cut" ? "" : "hidden"}>
                  <VideoCut key={`video-${resetKey}`} active={activeTab === "video-cut"} />
                </div>
                <div className={activeTab === "batch-video-trim" ? "" : "hidden"}>
                  <BatchVideoTrim key={`batch-video-${resetKey}`} active={activeTab === "batch-video-trim"} />
                </div>
                <div className={activeTab === "video-convert" ? "" : "hidden"}>
                  <VideoConvert key={`convert-${resetKey}`} active={activeTab === "video-convert"} />
                </div>
                <div className={activeTab === "text-to-image" ? "" : "hidden"}>
                  <TextToImage key={`text-to-image-${resetKey}`} active={activeTab === "text-to-image"} />
                </div>
                <div className={activeTab === "watermark" ? "" : "hidden"}>
                  <Watermark key={`watermark-${resetKey}`} active={activeTab === "watermark"} />
                </div>
              </div>
            </main>
          </div>

          <Modal
            open={showResetConfirm}
            onClose={() => setShowResetConfirm(false)}
            accessibleTitle="重置当前工作区"
            className="max-w-md"
          >
            <div className="space-y-5 p-6">
              <div>
                <CardTitle className="text-xl">重置当前工作区？</CardTitle>
              </div>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setShowResetConfirm(false)}>
                  取消
                </Button>
                <Button variant="primary" onClick={handleReset}>
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
        </TaskCenterProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

export default App;
