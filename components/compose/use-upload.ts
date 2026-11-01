"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Media, MediaInfo } from "@/lib/types";
import { probeImage, probeVideo, uploadMedia } from "./upload";

export interface UploadState {
  file: File;
  objectUrl: string;
  info: MediaInfo;
  status: "probing" | "uploading" | "done" | "error";
  progress: number;
  media: Media | null;
  error?: string;
}

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

  const select = useCallback(
    async (file: File) => {
      clear();
      const id = ++seq.current;
      const objectUrl = URL.createObjectURL(file);
      urlRef.current = objectUrl;
      const base: MediaInfo = { mimeType: file.type || undefined, sizeBytes: file.size };
      setState({ file, objectUrl, info: base, status: "probing", progress: 0, media: null });

      const info: MediaInfo =
        kind === "video" ? await probeVideo(file, objectUrl) : { ...base, ...(await probeImage(objectUrl)) };
      if (id !== seq.current) return;
      setState((s) => (s ? { ...s, info, status: "uploading" } : s));

      const { promise, abort } = uploadMedia(file, info, (p) => {
        if (id === seq.current) setState((s) => (s ? { ...s, progress: p } : s));
      });
      abortRef.current = abort;
      try {
        const media = await promise;
        if (id !== seq.current) return;
        setState((s) => (s ? { ...s, media, status: "done", progress: 1 } : s));
      } catch (err) {
        if (id !== seq.current) return;
        setState((s) => (s ? { ...s, status: "error", error: (err as Error).message } : s));
      } finally {
        if (id === seq.current) abortRef.current = null;
      }
    },
    [clear, kind],
  );

  return { state, select, clear };
}
