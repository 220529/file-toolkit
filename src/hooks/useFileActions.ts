import { openFilePath, revealFilePath } from "../api/tauri";
import { useToast } from "../components/Toast";

export function useFileActions() {
  const toast = useToast();

  async function openFile(path: string) {
    try {
      await openFilePath(path);
    } catch (e) {
      toast.error("打开文件失败: " + e);
    }
  }

  async function revealInDir(path: string) {
    try {
      await revealFilePath(path);
    } catch (e) {
      toast.error("打开所在位置失败: " + e);
    }
  }

  return {
    openFile,
    revealInDir,
  };
}
