type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

function flatten(value: ClassValue, classes: string[]) {
  if (!value) return;

  if (typeof value === "string" || typeof value === "number") {
    classes.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flatten(item, classes));
    return;
  }

  Object.entries(value).forEach(([key, enabled]) => {
    if (enabled) classes.push(key);
  });
}

export function cn(...values: ClassValue[]) {
  const classes: string[] = [];
  values.forEach((value) => flatten(value, classes));
  return classes.join(" ");
}
