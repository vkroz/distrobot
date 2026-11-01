import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffprobeCandidates, mergeMetadata, parseFfprobeOutput, probeVideo } from "@/lib/media/probe";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const hasFfprobe = ffprobeCandidates().length > 0;

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-"));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

describe("parseFfprobeOutput", () => {
  it("reads duration and dimensions from the first real video stream", () => {
    expect(
      parseFfprobeOutput({
        streams: [
          { codec_type: "audio", codec_name: "aac" },
          { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } },
          { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        ],
        format: { duration: "12.480000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      }),
    ).toMatchObject({ durationSec: 12.48, width: 1920, height: 1080, codec: "h264", rotation: 0 });
  });

  it("swaps dimensions for phone videos rotated 90°/-90° (display matrix or legacy rotate tag)", () => {
    const base = { codec_type: "video", width: 1920, height: 1080 };
    expect(parseFfprobeOutput({ streams: [{ ...base, side_data_list: [{ rotation: -90 }] }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(parseFfprobeOutput({ streams: [{ ...base, tags: { rotate: "270" } }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(parseFfprobeOutput({ streams: [{ ...base, tags: { rotate: "180" } }] })).toMatchObject({ width: 1920, height: 1080 });
  });

  it("falls back to stream duration and returns null without a video stream", () => {
    expect(parseFfprobeOutput({ streams: [{ codec_type: "video", width: 10, height: 10, duration: "3.5" }], format: {} })!.durationSec).toBe(3.5);
    expect(parseFfprobeOutput({ streams: [{ codec_type: "audio" }] })).toBeNull();
  });
});

describe("mergeMetadata", () => {
  it("prefers ffprobe values and falls back per field to the browser", () => {
    expect(mergeMetadata({ durationSec: 99, width: 1, height: 2 }, { durationSec: 10, width: 1080, height: 1920 })).toEqual({
      durationSec: 10,
      width: 1080,
      height: 1920,
      source: "ffprobe",
    });
    expect(mergeMetadata({ durationSec: 30, width: 720, height: 1280 }, { width: 1080, height: 1920 })).toMatchObject({
      durationSec: 30,
      width: 1080,
      source: "ffprobe",
    });
    expect(mergeMetadata({ durationSec: 30 }, null)).toEqual({ durationSec: 30, width: undefined, height: undefined, source: "client" });
    expect(mergeMetadata({}, null).source).toBeNull();
  });
});

describe("probeVideo", () => {
  it("returns null when no ffprobe binary can be run", async () => {
    expect(await probeVideo("/tmp/whatever.mp4", { candidates: ["/nonexistent/ffprobe", "/also/missing"] })).toBeNull();
  });

  it.skipIf(!hasFfprobe)("returns null for a file that isn't a video (no fallback to other binaries)", async () => {
    const f = path.join(dir, "not-video.mp4");
    await fs.writeFile(f, "definitely not a video");
    expect(await probeVideo(f)).toBeNull();
  });

  it.skipIf(!hasFfmpeg || !hasFfprobe)("measures a real vertical video, skipping missing binaries first", async () => {
    const f = path.join(dir, "vertical.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=2", "-pix_fmt", "yuv420p", "-y", f]);
    const result = await probeVideo(f, { candidates: ["/nonexistent/ffprobe", ...ffprobeCandidates()] });
    expect(result).toMatchObject({ width: 360, height: 640 });
    expect(result!.durationSec).toBeCloseTo(2, 1);
  });
});
