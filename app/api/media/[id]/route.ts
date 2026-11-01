import fs from "node:fs";
import { Readable } from "node:stream";
import { getDb } from "@/lib/db";
import { getMedia } from "@/lib/db/repo";
import { errorJson } from "@/lib/http";
import { resolveStoragePath } from "@/lib/storage/local";

/** Serve an uploaded file (thumbnails / previews). No range support yet. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const media = getMedia(getDb(), id);
  if (!media) return errorJson("Not found", 404);
  const abs = resolveStoragePath(media.storagePath);
  if (!fs.existsSync(abs)) return errorJson("File missing", 404);
  const stream = Readable.toWeb(fs.createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": media.mimeType ?? "application/octet-stream",
      "Content-Length": String(media.sizeBytes ?? fs.statSync(abs).size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
