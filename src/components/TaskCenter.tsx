import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface TaskItem {
  id: string;
  title: string;
  stage: string;
  detail?: string;
  progress?: number;
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
    setTasksMap((prev) => ({ ...prev, [task.id]: task }));
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
    <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex flex-wrap gap-2">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="min-w-[240px] flex-1 rounded-[8px] border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900">{task.title}</div>
                <div className="truncate text-xs text-slate-500">{task.stage}</div>
                {task.detail && <div className="truncate text-xs text-slate-400">{task.detail}</div>}
              </div>
              {task.cancellable && task.onCancel && (
                <button
                  onClick={() => cancelTask(task)}
                  disabled={cancellingTaskIds.has(task.id)}
                  className="rounded-[10px] border border-rose-100 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:border-rose-200 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cancellingTaskIds.has(task.id) ? "取消中" : "取消"}
                </button>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80">
              {typeof task.progress === "number" ? (
                <div
                  className="h-full rounded-full bg-[var(--brand-600)] transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(task.progress, 100))}%` }}
                />
              ) : (
                <div className="h-full w-full animate-pulse bg-[var(--brand-500)]" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
