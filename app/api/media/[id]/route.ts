import fs from "node:fs";
import { Readable } from "node:stream";
import { getDb } from "@/lib/db";
import { getMedia } from "@/lib/db/repo";
import { errorJson, parseRange } from "@/lib/http";
import { resolveStoragePath } from "@/lib/storage/local";

/** Serve an uploaded file (thumbnails / video previews), with single-range support for seeking/Safari. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const media = getMedia(getDb(), id);
  if (!media) return errorJson("Not found", 404);
  const abs = resolveStoragePath(media.storagePath);
  if (!fs.existsSync(abs)) return errorJson("File missing", 404);
  const size = fs.statSync(abs).size;

  // Only ever serve as video/image; never let a stored file be interpreted as HTML/SVG/script.
  const type =
    media.mimeType && /^(video\/[\w.+-]+|image\/(jpeg|png|webp))$/.test(media.mimeType) ? media.mimeType : "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": type === "application/octet-stream" ? "attachment" : "inline",
  };

  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (range) {
    const stream = Readable.toWeb(fs.createReadStream(abs, { start: range.start, end: range.end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(abs)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}
