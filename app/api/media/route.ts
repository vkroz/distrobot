import { NextResponse } from "next/server";
import { isCrossOriginWrite, sessionFromRequest } from "@/lib/auth";
import { sessionsValidAfter } from "@/lib/auth-store";
import { getDb } from "@/lib/db";
import { createMedia } from "@/lib/db/repo";
import { mergeMetadata, probeVideo } from "@/lib/media/probe";
import { GB, MB } from "@/lib/platforms/rules";
import { deleteStoredFile, resolveStoragePath, saveStream } from "@/lib/storage/local";

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
 * Videos are re-measured on the server with ffprobe; the browser-reported duration/width/height
 * are only used for fields ffprobe can't determine (or when ffprobe isn't available).
 * Response `media.metadataSource` says which one was used.
 *
 * Auth is checked here rather than in proxy.ts: the proxy would buffer (and truncate) the body.
 */
export async function POST(req: Request) {
  if (isCrossOriginWrite(req)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  if (!sessionFromRequest(req, undefined, sessionsValidAfter())) {
    return NextResponse.json({ error: "Unauthorized: log in first (POST /api/session)" }, { status: 401 });
  }
  if (!req.body) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  const url = new URL(req.url);
  const filename = url.searchParams.get("filename") ?? "upload";
  const mimeType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || undefined;
  const kind = mimeType && /^video\/[a-z0-9.+-]+$/.test(mimeType) ? "video" : mimeType && IMAGE_TYPES.includes(mimeType) ? "image" : null;
  if (!kind) {
    return NextResponse.json({ error: `Expected a video or JPEG/PNG/WebP image, got ${mimeType ?? "unknown"}` }, { status: 415 });
  }
  let stored;
  try {
    stored = await saveStream(req.body, filename, { maxBytes: kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  // Never accept a silently truncated upload (aborted client, proxy body limits, ...).
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0 && declared !== stored.sizeBytes) {
    await deleteStoredFile(stored.storagePath).catch(() => undefined);
    return NextResponse.json(
      { error: `Upload incomplete: received ${stored.sizeBytes} of ${declared} bytes. Please try again.` },
      { status: 400 },
    );
  }
  const client = {
    durationSec: optNum(url.searchParams.get("durationSec")),
    width: optNum(url.searchParams.get("width")),
    height: optNum(url.searchParams.get("height")),
  };
  const probed = kind === "video" ? await probeVideo(resolveStoragePath(stored.storagePath)) : null;
  const meta = kind === "video" ? mergeMetadata(client, probed) : { ...client, source: null };
  const media = createMedia(getDb(), {
    kind,
    originalFilename: filename,
    storagePath: stored.storagePath,
    mimeType,
    sizeBytes: stored.sizeBytes,
    checksum: stored.checksum,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    metadataSource: meta.source,
  });
  return NextResponse.json({ media }, { status: 201 });
}
