import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveStoragePath, saveStream } from "@/lib/storage/local";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-uploads-"));
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

const streamOf = (data: string) => new Blob([data]).stream();

describe("local storage", () => {
  it("streams to disk with size and sha256", async () => {
    const stored = await saveStream(streamOf("hello"), "Clip.MP4", { dir });
    expect(stored.sizeBytes).toBe(5);
    expect(stored.checksum).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(stored.storagePath).toMatch(/\.mp4$/);
    expect(await fs.readFile(resolveStoragePath(stored.storagePath, dir), "utf8")).toBe("hello");
  });

  it("rejects oversized uploads and cleans up", async () => {
    await expect(saveStream(streamOf("x".repeat(100)), "a.mp4", { dir, maxBytes: 10 })).rejects.toThrow(/exceeds/);
  });

  it("drops unsafe extensions and refuses path traversal", async () => {
    const stored = await saveStream(streamOf("x"), "evil.sh;rm -rf", { dir });
    expect(path.extname(stored.storagePath)).toBe("");
    expect(() => resolveStoragePath("../../etc/passwd", dir)).toThrow();
  });
});
