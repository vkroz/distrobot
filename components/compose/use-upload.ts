"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Media, MediaInfo } from "@/lib/types";
import { probeImage, probeVideo, uploadMedia } from "./upload";

export interface UploadState {
  /** Local file (null when restored from an existing upload, e.g. a saved draft). */
  file: File | null;
  name: string;
  /** blob: URL for local files, /api/media/:id for existing uploads. */
  objectUrl: string;
  /** Metadata used for validation: server-measured values win over browser values. */
  info: MediaInfo;
  /** Where duration/dimensions come from. */
  source: "ffprobe" | "browser" | null;
  status: "probing" | "uploading" | "done" | "error";
  progress: number;
  media: Media | null;
  error?: string;
}

/** Prefer the server's (ffprobe) values; keep browser values for anything the server didn't measure. */
export function mergeServerInfo(local: MediaInfo, media: Media): { info: MediaInfo; source: UploadState["source"] } {
  const info: MediaInfo = {
    mimeType: media.mimeType ?? local.mimeType,
    sizeBytes: media.sizeBytes ?? local.sizeBytes,
    durationSec: media.durationSec ?? local.durationSec,
    width: media.width ?? local.width,
    height: media.height ?? local.height,
  };
  const source = media.metadataSource === "ffprobe" ? "ffprobe" : info.durationSec || info.width ? "browser" : null;
  return { info, source };
}

const mediaToState = (media: Media): UploadState => {
  const { info, source } = mergeServerInfo({}, media);
  return {
    file: null,
    name: media.originalFilename,
    objectUrl: `/api/media/${media.id}`,
    info,
    source,
    status: "done",
    progress: 1,
    media,
  };
};

/** Select → probe metadata locally → upload with progress. Revokes object URLs on replace/unmount. */
export function useUpload(kind: "video" | "image") {
  const [state, setState] = useState<UploadState | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const urlRef = useRef<string | null>(null);
  const seq = useRef(0);

  const clear = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    seq.current++;
    setState(null);
  }, []);

  useEffect(() => clear, [clear]);

  /** Show an already-uploaded file (draft editing). */
  const setExisting = useCallback(
    (media: Media | null) => {
      clear();
      if (media) setState(mediaToState(media));
    },
    [clear],
  );

  const select = useCallback(
    async (file: File) => {
      clear();
      const id = ++seq.current;
      const objectUrl = URL.createObjectURL(file);
      urlRef.current = objectUrl;
      const base: MediaInfo = { mimeType: file.type || undefined, sizeBytes: file.size };
      setState({ file, name: file.name, objectUrl, info: base, source: null, status: "probing", progress: 0, media: null });

      const info: MediaInfo =
        kind === "video" ? await probeVideo(file, objectUrl) : { ...base, ...(await probeImage(objectUrl)) };
      if (id !== seq.current) return;
      setState((s) => (s ? { ...s, info, source: info.durationSec || info.width ? "browser" : null, status: "uploading" } : s));

      const { promise, abort } = uploadMedia(file, info, (p) => {
        if (id === seq.current) setState((s) => (s ? { ...s, progress: p } : s));
      });
      abortRef.current = abort;
      try {
        const media = await promise;
        if (id !== seq.current) return;
        setState((s) => {
          if (!s) return s;
          const merged = kind === "video" ? mergeServerInfo(s.info, media) : { info: s.info, source: s.source };
          return { ...s, ...merged, media, status: "done", progress: 1 };
        });
      } catch (err) {
        if (id !== seq.current) return;
        setState((s) => (s ? { ...s, status: "error", error: (err as Error).message } : s));
      } finally {
        if (id === seq.current) abortRef.current = null;
      }
    },
    [clear, kind],
  );

  return { state, select, clear, setExisting };
}
