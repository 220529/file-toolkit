function getLastSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

export function getBaseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = getLastSeparatorIndex(normalized);
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function getDirName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = getLastSeparatorIndex(normalized);
  return index >= 0 ? normalized.slice(0, index) : "";
}

export function getPathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinPath(dir: string, name: string, separator = "/"): string {
  return dir ? `${dir}${separator}${name}` : name;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function getExtension(path: string): string {
  const baseName = getBaseName(path);
  const index = baseName.lastIndexOf(".");
  return index > 0 ? baseName.slice(index + 1) : "";
}
