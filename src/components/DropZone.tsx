import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

interface DropZoneProps {
  onSelect: (path: string) => void;
  loading?: boolean;
  selectedPath?: string;
}

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

export default function DropZone({ onSelect, loading, selectedPath }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // 监听 Tauri 的拖拽进入事件
    const unlistenEnter = listen<DragDropPayload>("tauri://drag-enter", () => {
      setDragging(true);
    });

    // 监听 Tauri 的拖拽离开事件
    const unlistenLeave = listen("tauri://drag-leave", () => {
      setDragging(false);
    });

    // 监听 Tauri 的拖拽放下事件
    const unlistenDrop = listen<DragDropPayload>("tauri://drag-drop", (event) => {
      setDragging(false);
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        // 取第一个路径
        onSelect(paths[0]);
      }
    });

    return () => {
      unlistenEnter.then((fn) => fn());
      unlistenLeave.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
    };
  }, [onSelect]);

  const handleClick = async () => {
    if (loading) return;
    const selected = await open({ directory: true, title: "选择文件夹" });
    if (selected) {
      onSelect(selected as string);
    }
  };

  return (
    <div className="card p-6">
      <div
        onClick={handleClick}
        className={`drop-zone ${dragging ? "dragging" : ""}`}
      >
        <div className="text-5xl mb-4">
          {loading ? "⏳" : dragging ? "📂" : "📁"}
        </div>
        <div className="text-base text-gray-600 mb-2">
          {loading ? "扫描中，请稍候..." : dragging ? "松开以选择文件夹" : "拖入文件夹 或 点击选择"}
        </div>
        <div className="text-sm text-gray-400">
          支持递归扫描所有子文件夹
        </div>
      </div>

      {selectedPath && (
        <div className="mt-4 px-3 py-2 bg-gray-50 rounded text-sm text-gray-500 truncate">
          📂 {selectedPath}
        </div>
      )}
    </div>
  );
}
