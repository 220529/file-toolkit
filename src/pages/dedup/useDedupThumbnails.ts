import { useCallback, useRef, useState } from "react";
import { getFileThumbnail } from "../../api/tauri";

function useThumbnailMap() {
  const mapRef = useRef<Map<string, string>>(new Map());
  const [map, setMapState] = useState(mapRef.current);

  const setEntry = useCallback((key: string, value: string) => {
    const next = new Map(mapRef.current).set(key, value);
    mapRef.current = next;
    setMapState(next);
  }, []);

  const reset = useCallback(() => {
    const next = new Map<string, string>();
    mapRef.current = next;
    setMapState(next);
  }, []);

  return { map, mapRef, reset, setEntry };
}

export function useDedupThumbnails() {
  const {
    map: groupThumbnails,
    mapRef: groupThumbnailsRef,
    reset: resetGroupThumbnails,
    setEntry: setGroupThumbnail,
  } = useThumbnailMap();
  const {
    map: fileThumbnails,
    mapRef: fileThumbnailsRef,
    reset: resetFileThumbnails,
    setEntry: setFileThumbnail,
  } = useThumbnailMap();
  const pendingGroupThumbnails = useRef(new Set<string>());
  const pendingFileThumbnails = useRef(new Set<string>());

  const loadGroupThumbnail = useCallback(
    async (hash: string, path: string) => {
      if (groupThumbnailsRef.current.has(hash) || pendingGroupThumbnails.current.has(hash)) return;
      pendingGroupThumbnails.current.add(hash);
      try {
        const thumb = await getFileThumbnail(path);
        setGroupThumbnail(hash, thumb);
      } catch {
        setGroupThumbnail(hash, "");
      } finally {
        pendingGroupThumbnails.current.delete(hash);
      }
    },
    [groupThumbnailsRef, setGroupThumbnail]
  );

  const loadFileThumbnail = useCallback(
    async (path: string) => {
      if (fileThumbnailsRef.current.has(path) || pendingFileThumbnails.current.has(path)) return;
      pendingFileThumbnails.current.add(path);
      try {
        const thumb = await getFileThumbnail(path);
        setFileThumbnail(path, thumb);
      } catch {
        setFileThumbnail(path, "");
      } finally {
        pendingFileThumbnails.current.delete(path);
      }
    },
    [fileThumbnailsRef, setFileThumbnail]
  );

  const resetThumbnails = useCallback(() => {
    resetGroupThumbnails();
    resetFileThumbnails();
    pendingGroupThumbnails.current.clear();
    pendingFileThumbnails.current.clear();
  }, [resetFileThumbnails, resetGroupThumbnails]);

  return {
    groupThumbnails,
    fileThumbnails,
    loadFileThumbnail,
    loadGroupThumbnail,
    resetThumbnails,
  };
}
