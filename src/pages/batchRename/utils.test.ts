import { describe, expect, it } from "vitest";
import { buildRenamePreview, collectRenameTargetPaths, defaultRenameRule, readyRenameOperations } from "./utils";

describe("batchRename utils", () => {
  it("builds numbered preview names with prefix and suffix", () => {
    const preview = buildRenamePreview(
      ["/tmp/photo.JPG", "/tmp/clip.mov"],
      {
        ...defaultRenameRule,
        prefix: "new-",
        suffix: "-",
        startNumber: 3,
        padding: 3,
        extensionCase: "lower",
      }
    );

    expect(preview.map((item) => item.nextName)).toEqual(["new-photo-003.jpg", "new-clip-004.mov"]);
    expect(preview.every((item) => item.status === "ready")).toBe(true);
  });

  it("applies find and replace before case conversion", () => {
    const preview = buildRenamePreview(["/tmp/My File.txt"], {
      ...defaultRenameRule,
      numbering: false,
      find: " ",
      replace: "_",
      nameCase: "lower",
    });

    expect(preview[0].nextName).toBe("my_file.txt");
  });

  it("marks unchanged and duplicate targets", () => {
    const unchanged = buildRenamePreview(["/tmp/a.txt"], {
      ...defaultRenameRule,
      numbering: false,
    });
    expect(unchanged[0].status).toBe("unchanged");

    const duplicate = buildRenamePreview(["/tmp/a.txt", "/tmp/b.txt"], {
      ...defaultRenameRule,
      numbering: false,
      find: "a",
      replace: "b",
    });
    expect(duplicate.map((item) => item.status)).toEqual(["duplicate", "duplicate"]);
  });

  it("returns operations for ready items only", () => {
    const preview = buildRenamePreview(["/tmp/a.txt", "/tmp/b.txt"], {
      ...defaultRenameRule,
      prefix: "x-",
      numbering: false,
    });

    expect(readyRenameOperations(preview)).toEqual([
      { from: "/tmp/a.txt", to: "/tmp/x-a.txt" },
      { from: "/tmp/b.txt", to: "/tmp/x-b.txt" },
    ]);
  });

  it("marks existing target paths", () => {
    const preview = buildRenamePreview(
      ["/tmp/a.txt"],
      {
        ...defaultRenameRule,
        prefix: "x-",
        numbering: false,
      },
      { existingTargetPaths: new Set(["/tmp/x-a.txt"]) }
    );

    expect(preview[0].status).toBe("exists");
    expect(readyRenameOperations(preview)).toEqual([]);
  });

  it("collects target paths that should be checked on disk", () => {
    const preview = buildRenamePreview(["/tmp/a.txt", "/tmp/b.txt"], {
      ...defaultRenameRule,
      prefix: "x-",
      numbering: false,
    });

    expect(collectRenameTargetPaths(preview)).toEqual(["/tmp/x-a.txt", "/tmp/x-b.txt"]);
  });
});
