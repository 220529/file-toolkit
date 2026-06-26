import { useEffect, useState, type RefObject } from "react";

export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: readonly unknown[] = []
) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.max(0, Math.round(nextWidth));
      setWidth((current) => (current === roundedWidth ? current : roundedWidth));
    };

    updateWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      const observedElement = element;
      function handleResize() {
        updateWidth(observedElement.getBoundingClientRect().width);
      }

      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, deps);

  return width;
}
