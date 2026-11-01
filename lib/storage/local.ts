import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export function uploadDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads"));
}

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;

export interface StoredFile {
  /** Path relative to the upload dir (what we persist in the DB). */
  storagePath: string;
  sizeBytes: number;
  checksum: string;
}

/** Stream a web `ReadableStream` (e.g. `File.stream()` / request body) to disk, hashing as it goes. */
export async function saveStream(
  body: ReadableStream<Uint8Array>,
  originalFilename: string,
  opts: { maxBytes?: number; dir?: string } = {},
): Promise<StoredFile> {
  const dir = opts.dir ?? uploadDir();
  const ext = path.extname(originalFilename).toLowerCase();
  const name = `${randomUUID()}${SAFE_EXT.test(ext) ? ext : ""}`;
  // Shard by first two chars to keep directories small.
  const rel = path.join(name.slice(0, 2), name);
  const abs = path.join(/*turbopackIgnore: true*/ dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (opts.maxBytes !== undefined && size > opts.maxBytes) {
        cb(new Error(`Upload exceeds ${opts.maxBytes} bytes`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), meter, createWriteStream(abs));
  } catch (err) {
    await fs.rm(abs, { force: true });
    throw err;
  }
  return { storagePath: rel, sizeBytes: size, checksum: hash.digest("hex") };
}

/** Resolve a stored relative path, refusing anything that escapes the upload dir. */
export function resolveStoragePath(storagePath: string, dir = uploadDir()): string {
  const base = path.resolve(dir);
  const abs = path.resolve(base, storagePath);
  if (!abs.startsWith(base + path.sep)) throw new Error("Invalid storage path");
  return abs;
}

export function openStoredFile(storagePath: string, dir?: string) {
  return createReadStream(/*turbopackIgnore: true*/ resolveStoragePath(storagePath, dir));
}

export async function deleteStoredFile(storagePath: string, dir?: string): Promise<void> {
  await fs.rm(resolveStoragePath(storagePath, dir), { force: true });
}
