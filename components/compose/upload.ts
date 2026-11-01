import type { Media, MediaInfo } from "@/lib/types";

/** Read duration and dimensions from a local video file using a detached <video> element. */
export function probeVideo(file: File, objectUrl: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const base: MediaInfo = { mimeType: file.type || undefined, sizeBytes: file.size };
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = (info: MediaInfo) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(info);
    };
    // Some codecs (e.g. HEVC in some browsers) can't be decoded: fall back to size/type only.
    const timer = setTimeout(() => done(base), 10_000);
    video.onloadedmetadata = () =>
      done({
        ...base,
        durationSec: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      });
    video.onerror = () => done(base);
    video.src = objectUrl;
  });
}

export function probeImage(objectUrl: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = objectUrl;
  });
}

/** Stream a file to /api/media with progress (fetch has no upload progress). */
export function uploadMedia(
  file: File,
  info: MediaInfo,
  onProgress: (fraction: number) => void,
): { promise: Promise<Media>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const params = new URLSearchParams({ filename: file.name });
  if (info.durationSec) params.set("durationSec", String(info.durationSec));
  if (info.width) params.set("width", String(info.width));
  if (info.height) params.set("height", String(info.height));

  const promise = new Promise<Media>((resolve, reject) => {
    xhr.open("POST", `/api/media?${params}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { media?: Media; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.media) resolve(body.media);
      else reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
