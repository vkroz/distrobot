import { NextResponse } from "next/server";
import { MB } from "@/lib/platforms/rules";
import { getDb } from "@/lib/db";
import { createMedia } from "@/lib/db/repo";
import { GB } from "@/lib/platforms/rules";
import { saveStream } from "@/lib/storage/local";

const MAX_VIDEO_BYTES = 10 * GB;
/** YouTube's custom thumbnail limit is 2 MB; allow some headroom for other platforms. */
const MAX_IMAGE_BYTES = 10 * MB;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const optNum = (v: string | null) => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Raw-body upload of a video or thumbnail image (streamed to ./data/uploads, never buffered in memory).
 *   POST /api/media?filename=clip.mp4&durationSec=12.3&width=1080&height=1920
 *   Content-Type: video/mp4
 * Duration/dimensions are client-reported (read from a <video> element) until server-side probing exists.
 */
export async function POST(req: Request) {
  if (!req.body) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  const url = new URL(req.url);
  const filename = url.searchParams.get("filename") ?? "upload";
  const mimeType = req.headers.get("content-type")?.split(";")[0].trim() || undefined;
  const kind = mimeType?.startsWith("video/") ? "video" : mimeType && IMAGE_TYPES.includes(mimeType) ? "image" : null;
  if (!kind) {
    return NextResponse.json({ error: `Expected a video or JPEG/PNG/WebP image, got ${mimeType ?? "unknown"}` }, { status: 415 });
  }
  try {
    const stored = await saveStream(req.body, filename, { maxBytes: kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES });
    const media = createMedia(getDb(), {
      kind,
      originalFilename: filename,
      storagePath: stored.storagePath,
      mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      durationSec: optNum(url.searchParams.get("durationSec")),
      width: optNum(url.searchParams.get("width")),
      height: optNum(url.searchParams.get("height")),
    });
    return NextResponse.json({ media }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
