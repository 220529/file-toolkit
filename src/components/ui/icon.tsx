import {
  Archive,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  File,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Info,
  List,
  MoreHorizontal,
  Music,
  Repeat,
  RotateCcw,
  Scissors,
  Table,
  TriangleAlert,
  Video,
  WandSparkles,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { cn } from "../../utils/cn";

export type IconName =
  | "app"
  | "archive"
  | "audio"
  | "batch"
  | "check"
  | "chevronLeft"
  | "chevronRight"
  | "close"
  | "convert"
  | "document"
  | "duplicate"
  | "file"
  | "folder"
  | "folderOpen"
  | "image"
  | "info"
  | "logs"
  | "magic"
  | "more"
  | "reset"
  | "scissors"
  | "spreadsheet"
  | "stats"
  | "video"
  | "warning";

const icons: Record<IconName, LucideIcon> = {
  app: FileText,
  archive: Archive,
  audio: Music,
  batch: Video,
  check: Check,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  close: X,
  convert: Repeat,
  document: FileText,
  duplicate: Copy,
  file: File,
  folder: Folder,
  folderOpen: FolderOpen,
  image: Image,
  info: Info,
  logs: List,
  magic: WandSparkles,
  more: MoreHorizontal,
  reset: RotateCcw,
  scissors: Scissors,
  spreadsheet: Table,
  stats: BarChart3,
  video: Video,
  warning: TriangleAlert,
};

export interface IconProps extends Omit<LucideProps, "ref"> {
  name: IconName;
}

export function Icon({ name, size = 18, strokeWidth = 1.8, className, ...props }: IconProps) {
  const Component = icons[name];
  return <Component aria-hidden="true" className={cn("inline-block shrink-0", className)} size={size} strokeWidth={strokeWidth} {...props} />;
}
