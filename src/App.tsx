import { useState } from "react";
import FileStats from "./pages/FileStats";
import Dedup from "./pages/Dedup";
import VideoCut from "./pages/VideoCut";
import "./index.css";

type Tab = "stats" | "dedup" | "video-cut" | "video-upscale";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "stats", label: "文件统计", icon: "📊" },
    { key: "dedup", label: "文件去重", icon: "🔍" },
    { key: "video-cut", label: "视频截取", icon: "✂️" },
    { key: "video-upscale", label: "视频超分", icon: "✨" },
  ];

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      {/* 顶部导航 */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center text-white text-sm">
              📁
            </div>
            <span className="font-semibold text-lg">File Toolkit</span>
          </div>
          <div className="text-sm text-gray-400">v0.1.0</div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto">
          <div className="flex">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-6 py-4 font-medium transition-all relative ${
                  activeTab === tab.key
                    ? "text-blue-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.label}
                {activeTab === tab.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 内容区域 - 使用 CSS 隐藏保持状态 */}
      <div className="max-w-4xl mx-auto py-6">
        <div className={activeTab === "stats" ? "" : "hidden"}>
          <FileStats />
        </div>
        <div className={activeTab === "dedup" ? "" : "hidden"}>
          <Dedup />
        </div>
        <div className={activeTab === "video-cut" ? "" : "hidden"}>
          <VideoCut />
        </div>
        <div className={activeTab === "video-upscale" ? "" : "hidden"}>
          <div className="card p-12 text-center">
            <div className="text-6xl mb-4">🚧</div>
            <div className="text-lg text-gray-500 mb-2">视频超分功能开发中</div>
            <div className="text-sm text-gray-400">AI 还原视频清晰度</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
