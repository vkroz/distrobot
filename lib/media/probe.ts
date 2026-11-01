import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaInfo } from "@/lib/types";

/**
 * Server-side video metadata via ffprobe.
 *
 * Binary lookup order (first one that runs wins):
 *   1. FFPROBE_PATH env var
 *   2. the optional npm dependency @ffprobe-installer/<platform>-<arch> (installed by `npm install`)
 *   3. `ffprobe` on PATH
 * If none is available or the file can't be parsed, callers fall back to browser-reported values.
 */

export interface ProbeResult {
  durationSec?: number;
  /** Display dimensions (already swapped for 90°/270° rotation). */
  width?: number;
  height?: number;
  codec?: string;
  rotation?: number;
  formatName?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number | string }>;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

const positive = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Extract duration and display dimensions from `ffprobe -show_format -show_streams -of json` output. */
export function parseFfprobeOutput(out: FfprobeOutput): ProbeResult | null {
  // Skip cover-art "video" streams (attached pictures in audio files / mp4 thumbnails).
  const video = out.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) return null;
  const rotationRaw = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate;
  const rotation = rotationRaw === undefined ? 0 : Number(rotationRaw) || 0;
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  const w = positive(video.width);
  const h = positive(video.height);
  return {
    durationSec: positive(out.format?.duration) ?? positive(video.duration),
    width: quarterTurn ? h : w,
    height: quarterTurn ? w : h,
    codec: video.codec_name,
    rotation,
    formatName: out.format?.format_name,
  };
}

export function ffprobeCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const bin = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const bundled = path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    "node_modules",
    "@ffprobe-installer",
    `${process.platform}-${process.arch}`,
    bin,
  );
  return [env.FFPROBE_PATH, fs.existsSync(bundled) ? bundled : undefined, "ffprobe"].filter((c): c is string => !!c);
}

type RunResult = { kind: "ok"; stdout: string } | { kind: "missing" } | { kind: "failed" };

/**
 * Containers we accept for uploaded videos. ffprobe picks a demuxer from the file's *content*, so
 * without this an uploaded HLS playlist / concat list could make it open URLs or local files (SSRF).
 */
export const PROBE_FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpeg,mpegts,asf,mxf,ogg";

export function ffprobeArgs(file: string): string[] {
  return [
    "-v", "error",
    "-protocol_whitelist", "file", // never touch the network
    "-format_whitelist", PROBE_FORMAT_WHITELIST,
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    // "file:" prefix so a path can never be parsed as an option or another protocol.
    `file:${path.resolve(file)}`,
  ];
}

function run(bin: string, file: string, timeoutMs: number): Promise<RunResult> {
  const args = ffprobeArgs(file);
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ kind: "ok", stdout });
      const code = (err as NodeJS.ErrnoException).code;
      // Binary not found / not executable → try the next candidate. Anything else = unreadable file.
      resolve(code === "ENOENT" || code === "EACCES" ? { kind: "missing" } : { kind: "failed" });
    });
  });
}

/** Probe a video file. Returns null when no ffprobe is available or the file isn't a readable video. */
export async function probeVideo(
  file: string,
  opts: { candidates?: string[]; timeoutMs?: number } = {},
): Promise<ProbeResult | null> {
  for (const bin of opts.candidates ?? ffprobeCandidates()) {
    const res = await run(bin, file, opts.timeoutMs ?? 15_000);
    if (res.kind === "missing") continue;
    if (res.kind === "failed") return null;
    try {
      return parseFfprobeOutput(JSON.parse(res.stdout) as FfprobeOutput);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Prefer server-measured values; fall back field-by-field to what the browser reported.
 * `source` is "ffprobe" when the probe produced any of duration/width/height.
 */
export function mergeMetadata(
  client: Pick<MediaInfo, "durationSec" | "width" | "height">,
  probed: ProbeResult | null,
): { durationSec?: number; width?: number; height?: number; source: "ffprobe" | "client" | null } {
  const merged = {
    durationSec: probed?.durationSec ?? client.durationSec,
    width: probed?.width ?? client.width,
    height: probed?.height ?? client.height,
  };
  const probedAny = !!probed && (probed.durationSec !== undefined || probed.width !== undefined || probed.height !== undefined);
  const clientAny = client.durationSec !== undefined || client.width !== undefined || client.height !== undefined;
  return { ...merged, source: probedAny ? "ffprobe" : clientAny ? "client" : null };
}
