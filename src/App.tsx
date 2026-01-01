import { useState } from "react";
import FileStats from "./pages/FileStats";
import Dedup from "./pages/Dedup";
import VideoCut from "./pages/VideoCut";
import "./index.css";

type Tab = "stats" | "dedup" | "video-cut" | "video-upscale";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");
  const [collapsed, setCollapsed] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "stats", label: "文件统计", icon: "📊" },
    { key: "dedup", label: "文件去重", icon: "🔍" },
    { key: "video-cut", label: "视频截取", icon: "✂️" },
    { key: "video-upscale", label: "视频超分", icon: "✨" },
  ];

  return (
    <div className="h-screen flex bg-[#f5f5f5]">
      {/* 左侧边栏 */}
      <div
        className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ${
          collapsed ? "w-12" : "w-36"
        }`}
      >
        {/* Logo */}
        <div className="p-2 border-b border-gray-100">
          <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : ""}`}>
            <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center text-white text-xs flex-shrink-0">
              📁
            </div>
            {!collapsed && (
              <span className="font-semibold text-xs whitespace-nowrap">File Toolkit</span>
            )}
          </div>
        </div>

        {/* 导航菜单 */}
        <nav className="flex-1 p-1 space-y-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`w-full flex items-center gap-2 px-2 py-2 rounded-md transition-all ${
                activeTab === tab.key
                  ? "bg-blue-50 text-blue-600"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              } ${collapsed ? "justify-center" : ""}`}
              title={collapsed ? tab.label : undefined}
            >
              <span className="text-base flex-shrink-0">{tab.icon}</span>
              {!collapsed && (
                <span className="text-xs font-medium whitespace-nowrap">{tab.label}</span>
              )}
            </button>
          ))}
        </nav>

        {/* 底部：设置 */}
        <div className="p-1 border-t border-gray-100">
          <button
            onClick={() => setShowAbout(true)}
            className="w-full flex items-center justify-center py-2 text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-md transition-all"
            title="关于"
          >
            <span className="text-base">⚙️</span>
          </button>
        </div>
      </div>

      {/* 收起/展开按钮 - 悬浮在侧边栏边缘 */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute top-1/2 -translate-y-1/2 w-4 h-8 bg-white border border-gray-200 rounded-r-md flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-all z-10 shadow-sm"
        style={{ left: collapsed ? "48px" : "144px" }}
        title={collapsed ? "展开" : "收起"}
      >
        <span
          className="text-xs transition-transform duration-300"
          style={{ transform: collapsed ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ◀
        </span>
      </button>

      {/* 右侧内容区 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center">
          <h1 className="text-base font-medium text-gray-800">
            {tabs.find((t) => t.key === activeTab)?.icon}{" "}
            {tabs.find((t) => t.key === activeTab)?.label}
          </h1>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-auto">
          <div className={activeTab === "stats" ? "" : "hidden"}>
            <FileStats active={activeTab === "stats"} />
          </div>
          <div className={activeTab === "dedup" ? "" : "hidden"}>
            <Dedup active={activeTab === "dedup"} />
          </div>
          <div className={activeTab === "video-cut" ? "" : "hidden"}>
            <VideoCut active={activeTab === "video-cut"} />
          </div>
          <div className={activeTab === "video-upscale" ? "" : "hidden"}>
            <div className="p-6">
              <div className="card p-12 text-center">
                <div className="text-6xl mb-4">🚧</div>
                <div className="text-lg text-gray-500 mb-2">视频超分功能开发中</div>
                <div className="text-sm text-gray-400">AI 还原视频清晰度</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 关于弹窗 */}
      {showAbout && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowAbout(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-72 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 text-center border-b border-gray-100">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center text-2xl mx-auto mb-3">
                📁
              </div>
              <h2 className="text-lg font-semibold mb-1">File Toolkit</h2>
              <p className="text-gray-400 text-xs">跨平台文件工具箱</p>
            </div>
            <div className="p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">版本</span>
                <span className="font-mono">v0.1.0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">技术栈</span>
                <span>Tauri + React + Rust</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">前端</span>
                <span>React 19 + TypeScript</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">后端</span>
                <span>Rust + Tauri 2.0</span>
              </div>
            </div>
            <div className="p-3 bg-gray-50 border-t border-gray-100">
              <button
                onClick={() => setShowAbout(false)}
                className="w-full py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
