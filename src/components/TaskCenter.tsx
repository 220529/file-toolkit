import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface TaskItem {
  id: string;
  title: string;
  stage: string;
  detail?: string;
  progress?: number;
  startedAt?: number;
  status?: "running" | "success" | "error";
  cancellable?: boolean;
  onCancel?: () => void | Promise<void>;
}

interface TaskCenterValue {
  tasks: TaskItem[];
  upsertTask: (task: TaskItem) => void;
  clearTask: (id: string) => void;
}

const TaskCenterContext = createContext<TaskCenterValue | null>(null);

export function TaskCenterProvider({ children }: { children: React.ReactNode }) {
  const [tasksMap, setTasksMap] = useState<Record<string, TaskItem>>({});

  const upsertTask = useCallback((task: TaskItem) => {
    setTasksMap((prev) => {
      const previous = prev[task.id];
      const previousProgress =
        previous && previous.status === "running" && typeof previous.progress === "number"
          ? previous.progress
          : undefined;
      const nextProgress =
        typeof task.progress === "number" && typeof previousProgress === "number"
          ? Math.max(previousProgress, task.progress)
          : task.progress;

      return {
        ...prev,
        [task.id]: {
          ...task,
          progress: nextProgress,
          startedAt: task.startedAt ?? previous?.startedAt ?? Date.now(),
          status: task.status ?? "running",
        },
      };
    });
  }, []);

  const clearTask = useCallback((id: string) => {
    setTasksMap((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const tasks = useMemo(() => Object.values(tasksMap), [tasksMap]);
  const value = useMemo(() => ({ tasks, upsertTask, clearTask }), [tasks, upsertTask, clearTask]);

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
}

export function useTaskCenter() {
  const context = useContext(TaskCenterContext);
  if (!context) {
    throw new Error("useTaskCenter must be used within TaskCenterProvider");
  }
  return context;
}

export function useTaskReporter(taskId: string) {
  const { upsertTask, clearTask } = useTaskCenter();

  const reportTask = useCallback(
    (task: Omit<TaskItem, "id">) => upsertTask({ id: taskId, ...task }),
    [taskId, upsertTask]
  );

  const clearCurrentTask = useCallback(() => {
    clearTask(taskId);
  }, [taskId, clearTask]);

  useEffect(() => {
    return clearCurrentTask;
  }, [clearCurrentTask]);

  return useMemo(
    () => ({
      reportTask,
      clearTask: clearCurrentTask,
    }),
    [reportTask, clearCurrentTask]
  );
}

export function TaskStatusBar() {
  const { tasks } = useTaskCenter();
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const visibleTaskIds = new Set(tasks.map((task) => task.id));
    setCancellingTaskIds((prev) => {
      const next = new Set(Array.from(prev).filter((taskId) => visibleTaskIds.has(taskId)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  const cancelTask = useCallback((task: TaskItem) => {
    if (!task.onCancel) return;
    if (cancellingTaskIds.has(task.id)) return;

    setCancellingTaskIds((prev) => new Set(prev).add(task.id));

    void Promise.resolve(task.onCancel()).finally(() => {
      setCancellingTaskIds((prev) => {
        if (!prev.has(task.id)) return prev;
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    });
  }, [cancellingTaskIds]);

  if (tasks.length === 0) return null;

  return (
    <div className="border-b border-[var(--stroke)] bg-[#f7f8f5] px-5 py-3">
      <div className="flex flex-wrap gap-2">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="min-w-[260px] flex-1 rounded-[8px] border border-[var(--stroke)] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(16,20,23,0.04)]"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--text-strong)]">{task.title}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span className="truncate">{task.stage}</span>
                  {task.startedAt && (
                    <span className="rounded-[5px] bg-[#eef3f5] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                      {formatElapsed(now - task.startedAt)}
                    </span>
                  )}
                </div>
                {task.detail && <div className="truncate text-xs text-[var(--text-soft)]">{task.detail}</div>}
              </div>
              {task.cancellable && task.onCancel && (
                <button
                  onClick={() => cancelTask(task)}
                  disabled={cancellingTaskIds.has(task.id)}
                  className="rounded-[8px] border border-[rgba(187,62,58,0.18)] bg-[#fff0ef] px-3 py-1.5 text-xs font-medium text-[var(--danger-600)] transition hover:border-[rgba(187,62,58,0.28)] hover:bg-[#ffe5e3] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cancellingTaskIds.has(task.id) ? "取消中" : "取消"}
                </button>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e3e8e8]">
              {typeof task.progress === "number" ? (
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getProgressTone(task.status)}`}
                  style={{ width: `${Math.max(0, Math.min(task.progress, 100))}%` }}
                />
              ) : (
                <div className={`h-full w-full animate-pulse ${getProgressTone(task.status)}`} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}h ${restMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function getProgressTone(status: TaskItem["status"]) {
  if (status === "success") return "bg-emerald-500";
  if (status === "error") return "bg-rose-500";
  return "bg-[var(--brand-600)]";
}
