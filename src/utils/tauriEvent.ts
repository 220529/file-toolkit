import { invoke, transformCallback } from "@tauri-apps/api/core";
import type { EventCallback, EventName, Options } from "@tauri-apps/api/event";

type TauriWindowInternals = Window & {
  __TAURI_INTERNALS__?: {
    unregisterCallback: (id: number) => void;
  };
};

export function safeListen<T>(event: EventName, handler: EventCallback<T>, options?: Options) {
  const target = typeof options?.target === "string"
    ? { kind: "AnyLabel" as const, label: options.target }
    : (options?.target ?? { kind: "Any" as const });
  const tauriWindow = window as TauriWindowInternals;
  let disposed = false;
  let eventId: number | null = null;
  const handlerId = transformCallback(handler);

  void invoke<number>("plugin:event|listen", {
    event,
    target,
    handler: handlerId,
  })
    .then((id) => {
      if (disposed) {
        void unlistenSafely(event, id, handlerId);
        return;
      }

      eventId = id;
    })
    .catch(() => {
      tauriWindow.__TAURI_INTERNALS__?.unregisterCallback(handlerId);
    });

  return () => {
    disposed = true;

    if (eventId == null) return;

    const nextEventId = eventId;
    eventId = null;

    void unlistenSafely(event, nextEventId, handlerId);
  };
}

async function unlistenSafely(event: EventName, eventId: number, handlerId: number) {
  const tauriWindow = window as TauriWindowInternals;

  try {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId);
  } catch {
    // Tauri 2.9.x can lose the listener entry during rapid remounts.
  }

  tauriWindow.__TAURI_INTERNALS__?.unregisterCallback(handlerId);

  await invoke("plugin:event|unlisten", {
    event,
    eventId,
  }).catch(() => {
    // Ignore duplicate backend teardown during rapid remounts.
  });
}
