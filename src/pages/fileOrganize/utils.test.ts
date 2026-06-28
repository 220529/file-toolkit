import { describe, expect, it } from "vitest";
import {
  buildOrganizePreview,
  classifyFileType,
  collectOrganizeTargetPaths,
  formatDateFolder,
  readyOrganizeOperations,
} from "./utils";

const sampleTime = new Date("2026-06-26T13:05:00+08:00").getTime();

describe("fileOrganize utils", () => {
  it("groups files by month from modified time", () => {
    const preview = buildOrganizePreview(
      [{ path: "/tmp/photo.jpg", size: 12, modifiedMs: sampleTime }],
      { mode: "date", dateGranularity: "month", outputDir: "/out" }
    );

    expect(preview[0].targetFolder).toBe("2026-06");
    expect(preview[0].targetPath).toBe("/out/2026-06/photo.jpg");
    expect(preview[0].status).toBe("ready");
  });

  it("supports year and day date folders", () => {
    expect(formatDateFolder(sampleTime, "year")).toBe("2026");
    expect(formatDateFolder(sampleTime, "day")).toBe("2026-06-26");
  });

  it("classifies common file types", () => {
    expect(classifyFileType("/tmp/a.PNG")).toBe("图片");
    expect(classifyFileType("/tmp/a.mov")).toBe("视频");
    expect(classifyFileType("/tmp/a.pdf")).toBe("文档");
    expect(classifyFileType("/tmp/a.zip")).toBe("压缩包");
    expect(classifyFileType("/tmp/a.unknown")).toBe("其他");
  });

  it("groups files by extension", () => {
    const preview = buildOrganizePreview(
      [
        { path: "/tmp/a.TXT", size: 1, modifiedMs: sampleTime },
        { path: "/tmp/README", size: 1, modifiedMs: sampleTime },
      ],
      { mode: "extension", dateGranularity: "month", outputDir: "/out" }
    );

    expect(preview.map((item) => item.targetFolder)).toEqual(["txt", "无扩展名"]);
  });

  it("marks duplicate target paths and excludes them from operations", () => {
    const preview = buildOrganizePreview(
      [
        { path: "/a/source.txt", size: 1, modifiedMs: sampleTime },
        { path: "/b/source.txt", size: 1, modifiedMs: sampleTime },
      ],
      { mode: "type", dateGranularity: "month", outputDir: "/out" }
    );

    expect(preview.map((item) => item.status)).toEqual(["duplicate", "duplicate"]);
    expect(readyOrganizeOperations(preview)).toEqual([]);
  });

  it("requires an output directory", () => {
    const preview = buildOrganizePreview(
      [{ path: "/tmp/a.txt", size: 1, modifiedMs: sampleTime }],
      { mode: "type", dateGranularity: "month", outputDir: "" }
    );

    expect(preview[0].status).toBe("invalid");
    expect(preview[0].reason).toContain("目标目录");
  });

  it("marks existing target paths", () => {
    const preview = buildOrganizePreview(
      [{ path: "/tmp/a.txt", size: 1, modifiedMs: sampleTime }],
      { mode: "type", dateGranularity: "month", outputDir: "/out" },
      { existingTargetPaths: new Set(["/out/文档/a.txt"]) }
    );

    expect(preview[0].status).toBe("exists");
    expect(readyOrganizeOperations(preview)).toEqual([]);
  });

  it("collects target paths that should be checked on disk", () => {
    const preview = buildOrganizePreview(
      [{ path: "/tmp/a.txt", size: 1, modifiedMs: sampleTime }],
      { mode: "type", dateGranularity: "month", outputDir: "/out" }
    );

    expect(collectOrganizeTargetPaths(preview)).toEqual(["/out/文档/a.txt"]);
  });
});
