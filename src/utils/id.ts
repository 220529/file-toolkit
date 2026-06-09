function randomToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createId(prefix: string) {
  return `${prefix}-${randomToken()}`;
}

export function createTaskId(scope: string) {
  return createId(`task-${scope}`);
}
