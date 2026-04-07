import { createContext, useContext, useEffect, useState } from "react";

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

  function upsertTask(task: TaskItem) {
    setTasksMap((prev) => ({ ...prev, [task.id]: task }));
  }

  function clearTask(id: string) {
    setTasksMap((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  return (
    <TaskCenterContext.Provider value={{ tasks: Object.values(tasksMap), upsertTask, clearTask }}>
      {children}
    </TaskCenterContext.Provider>
  );
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

  useEffect(() => {
    return () => {
      clearTask(taskId);
    };
  }, [taskId]);

  return {
    reportTask: (task: Omit<TaskItem, "id">) => upsertTask({ id: taskId, ...task }),
    clearTask: () => clearTask(taskId),
  };
}

export function TaskStatusBar() {
  const { tasks } = useTaskCenter();

  if (tasks.length === 0) return null;

  return (
    <div className="border-b border-gray-200 bg-white/90 px-6 py-3">
      <div className="flex flex-wrap gap-3">
        {tasks.map((task) => (
          <div
            key={task.id}
            className="min-w-[240px] flex-1 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800">{task.title}</div>
                <div className="text-xs text-gray-500 truncate">{task.stage}</div>
                {task.detail && <div className="text-xs text-gray-400 truncate">{task.detail}</div>}
              </div>
              {task.cancellable && task.onCancel && (
                <button
                  onClick={() => void task.onCancel?.()}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  取消
                </button>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200">
              {typeof task.progress === "number" ? (
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(task.progress, 100))}%` }}
                />
              ) : (
                <div className="h-full w-full bg-gradient-to-r from-blue-400 via-blue-500 to-blue-400 animate-pulse" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
