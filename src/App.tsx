import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardTitle } from "./components/ui/card";
import { Modal } from "./components/ui/modal";
import { TaskCenterProvider } from "./components/TaskCenter";
import { ToastProvider } from "./components/Toast";
import LogViewer from "./components/LogViewer";
import Dedup from "./pages/Dedup";
import FileStats from "./pages/FileStats";
import VideoConvert from "./pages/VideoConvert";
import VideoCut from "./pages/VideoCut";
import Watermark from "./pages/Watermark";
import { cn } from "./utils/cn";
import "./index.css";

type Tab = "stats" | "dedup" | "video-cut" | "video-convert" | "watermark";

const tabMeta: Record<Tab, { label: string; icon: string }> = {
  stats: { label: "文件统计", icon: "📊" },
  dedup: { label: "文件去重", icon: "🧬" },
  "video-cut": { label: "视频截取", icon: "✂️" },
  "video-convert": { label: "格式转换", icon: "🎞️" },
  watermark: { label: "水印处理", icon: "🪄" },
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
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showToolsMenu) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolsMenuRef.current?.contains(target)) return;
      setShowToolsMenu(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowToolsMenu(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showToolsMenu]);

  function handleReset() {
    setResetKey((current) => current + 1);
    setActiveTab("stats");
    setShowResetConfirm(false);
  }

  return (
    <ToastProvider>
      <TaskCenterProvider>
        <div className="h-screen overflow-hidden px-4 py-4 text-slate-900">
          <div className="relative flex h-full overflow-hidden rounded-[32px] border border-white/65 bg-[rgba(255,255,255,0.52)] shadow-[0_40px_120px_rgba(15,23,42,0.14)] backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(142,182,255,0.24),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(241,251,255,0.6),transparent_26%)]" />

            <aside
              className={cn(
                "relative z-10 flex h-full flex-col border-r border-white/60 bg-[rgba(246,249,255,0.82)] px-2.5 py-3 transition-all duration-300",
                collapsed ? "w-[58px]" : "w-[168px]"
              )}
            >
              <div
                className={cn(
                  "mb-4 flex items-center gap-2 rounded-[24px] border border-white/70 bg-white/58 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]",
                  collapsed && "flex-col justify-center"
                )}
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#316cf5_0%,#1943b7_100%)] text-lg text-white shadow-[0_16px_34px_rgba(49,108,245,0.24)]">
                  📁
                </div>
                {!collapsed && (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold tracking-[-0.02em] text-slate-900">小文喵</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">v{version}</div>
                  </div>
                )}
              </div>

              <button
                className={cn(
                  "absolute right-[-13px] top-1/2 z-20 flex h-12 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-white/92 text-slate-500 shadow-[0_14px_30px_rgba(15,23,42,0.12)] transition hover:text-[var(--brand-700)]",
                  collapsed && "right-[-12px] h-11 w-6.5"
                )}
                onClick={() => {
                  setCollapsed((value) => !value);
                  setShowToolsMenu(false);
                }}
                title={collapsed ? "展开导航" : "收起导航"}
              >
                <span className="text-base leading-none">{collapsed ? "›" : "‹"}</span>
              </button>

              <nav className="flex-1 space-y-1">
                {(Object.keys(tabMeta) as Tab[]).map((tab) => {
                  const item = tabMeta[tab];
                  const active = activeTab === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => {
                        setActiveTab(tab);
                        setShowToolsMenu(false);
                      }}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "group flex w-full items-center gap-2.5 rounded-[20px] px-2.5 py-2.5 text-left transition-all duration-200",
                        active
                          ? "bg-[linear-gradient(135deg,rgba(51,109,255,0.14),rgba(51,109,255,0.06))] text-[var(--brand-700)] shadow-[inset_0_0_0_1px_rgba(93,146,255,0.18)]"
                          : "text-slate-600 hover:bg-white/80 hover:text-slate-900",
                        collapsed && "justify-center px-0"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-2xl text-base transition-all",
                          active ? "bg-white text-[var(--brand-600)] shadow-[0_12px_24px_rgba(51,109,255,0.14)]" : "bg-white/70"
                        )}
                      >
                        {item.icon}
                      </div>
                      {!collapsed && <div className="truncate text-[13px] font-medium">{item.label}</div>}
                    </button>
                  );
                })}
              </nav>

              <div ref={toolsMenuRef} className="relative mt-4 border-t border-white/65 pt-4">
                {showToolsMenu && (
                  <div
                    className={cn(
                      "absolute bottom-16 z-20 rounded-[22px] border border-white/70 bg-white/94 p-2 shadow-[0_22px_46px_rgba(15,23,42,0.16)] backdrop-blur",
                      collapsed ? "left-0 w-[188px]" : "left-0 right-0"
                    )}
                  >
                    <button
                      className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                      onClick={() => {
                        setShowToolsMenu(false);
                        setShowResetConfirm(true);
                      }}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">↺</span>
                      <span className="font-medium">重置</span>
                    </button>
                    <button
                      className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                      onClick={() => {
                        setShowToolsMenu(false);
                        setShowLogs(true);
                      }}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">☰</span>
                      <span className="font-medium">日志</span>
                    </button>
                    <button
                      className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                      onClick={() => {
                        setShowToolsMenu(false);
                        setShowAbout(true);
                      }}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">i</span>
                      <span className="font-medium">关于</span>
                    </button>
                  </div>
                )}
                <button
                  className={cn(
                    "group flex w-full items-center justify-center rounded-[20px] border border-white/70 bg-white/72 px-2.5 py-2.5 text-slate-600 shadow-[0_10px_24px_rgba(15,23,42,0.04)] transition hover:border-[rgba(93,146,255,0.28)] hover:bg-white hover:text-slate-900",
                    collapsed && "justify-center px-0"
                  )}
                  onClick={() => setShowToolsMenu((value) => !value)}
                  title="更多"
                >
                  <span className="text-[13px] font-medium">更多</span>
                </button>
              </div>
            </aside>

            <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-auto px-2 py-2" data-main-scroll="true">
                <div className={activeTab === "stats" ? "" : "hidden"}>
                  <FileStats key={`stats-${resetKey}`} active={activeTab === "stats"} />
                </div>
                <div className={activeTab === "dedup" ? "" : "hidden"}>
                  <Dedup key={`dedup-${resetKey}`} active={activeTab === "dedup"} />
                </div>
                <div className={activeTab === "video-cut" ? "" : "hidden"}>
                  <VideoCut key={`video-${resetKey}`} active={activeTab === "video-cut"} />
                </div>
                <div className={activeTab === "video-convert" ? "" : "hidden"}>
                  <VideoConvert key={`convert-${resetKey}`} active={activeTab === "video-convert"} />
                </div>
                <div className={activeTab === "watermark" ? "" : "hidden"}>
                  <Watermark key={`watermark-${resetKey}`} active={activeTab === "watermark"} />
                </div>
              </div>
            </main>
          </div>

          <Modal open={showResetConfirm} onClose={() => setShowResetConfirm(false)} className="max-w-md">
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

          <Modal open={showAbout} onClose={() => setShowAbout(false)} className="max-w-xl">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="text-xl font-semibold tracking-[-0.02em]">小文喵</div>
                  </div>
                </div>
                <Badge tone="info">v{version}</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Card>
                  <CardContent className="px-4 py-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">技术栈</div>
                    <div className="mt-2 text-sm font-medium text-slate-800">Tauri + React + Rust</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="px-4 py-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">设计目标</div>
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
    </ToastProvider>
  );
}

export default App;
