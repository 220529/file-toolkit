import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useToast } from "../components/Toast";

export function useFileActions() {
  const toast = useToast();

  async function openFile(path: string) {
    try {
      await invoke("open_file_path", { path });
    } catch (e) {
      toast.error("打开文件失败: " + e);
    }
  }

  async function revealInDir(path: string) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      toast.error("打开所在位置失败: " + e);
    }
  }

  return {
    openFile,
    revealInDir,
  };
}
