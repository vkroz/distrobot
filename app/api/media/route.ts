import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createMedia } from "@/lib/db/repo";
import { GB } from "@/lib/platforms/rules";
import { saveStream } from "@/lib/storage/local";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 10 * GB;

const optNum = (v: string | null) => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Raw-body upload (streamed to ./data/uploads, never buffered in memory).
 *   POST /api/media?filename=clip.mp4&durationSec=12.3&width=1080&height=1920
 *   Content-Type: video/mp4
 * Duration/dimensions are client-reported (read from a <video> element) until server-side probing exists.
 */
export async function POST(req: Request) {
  if (!req.body) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  const url = new URL(req.url);
  const filename = url.searchParams.get("filename") ?? "upload";
  const mimeType = req.headers.get("content-type")?.split(";")[0].trim() || undefined;
  if (mimeType && !mimeType.startsWith("video/")) {
    return NextResponse.json({ error: `Expected a video, got ${mimeType}` }, { status: 415 });
  }
  try {
    const stored = await saveStream(req.body, filename, { maxBytes: MAX_UPLOAD_BYTES });
    const media = createMedia(getDb(), {
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
