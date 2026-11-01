"use client";

import { useRef, useState, type DragEvent } from "react";
import { classifyOrientation } from "@/lib/platforms/validate";
import { cx, formatBytes, formatDuration } from "../ui";
import type { UploadState } from "./use-upload";

function Progress({ state }: { state: UploadState }) {
  if (state.status === "done") return <span className="text-xs font-medium text-emerald-600">Uploaded</span>;
  if (state.status === "error") return <span className="text-xs font-medium text-red-600">{state.error}</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${Math.round(state.progress * 100)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-neutral-500">
        {state.status === "probing" ? "Reading…" : `${Math.round(state.progress * 100)}%`}
      </span>
    </div>
  );
}

function DropZone({
  accept,
  onFile,
  children,
  className,
}: {
  accept: string;
  onFile: (f: File) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };
  return (
    <button
      type="button"
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        "flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-6 text-center transition",
        over
          ? "border-violet-500 bg-violet-50 dark:bg-violet-950/40"
          : "border-neutral-300 hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900",
        className,
      )}
    >
      {children}
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </button>
  );
}

function MetadataSource({ state }: { state: UploadState }) {
  if (state.status === "probing") return null;
  if (state.source === "ffprobe") {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-400" title="Duration and dimensions were measured on the server with ffprobe">
        ✓ Measured on server (ffprobe)
      </p>
    );
  }
  if (state.status === "uploading") return <p className="text-[11px] text-neutral-500">From browser · server will re-measure after upload</p>;
  if (state.source === "browser") {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-400" title="The server couldn't read this file with ffprobe; using what the browser reported">
        From browser (server measurement unavailable)
      </p>
    );
  }
  return <p className="text-[11px] text-amber-700 dark:text-amber-400">Duration/dimensions unknown — aspect and length checks are skipped</p>;
}

export function VideoPicker({ state, onFile, onClear }: { state: UploadState | null; onFile: (f: File) => void; onClear: () => void }) {
  if (!state) {
    return (
      <DropZone accept="video/*" onFile={onFile} className="min-h-48">
        <span className="text-3xl">🎬</span>
        <span className="text-sm font-medium">Drop a video or click to browse</span>
        <span className="text-xs text-neutral-500">MP4 (H.264/AAC) works everywhere. Duration and size are detected locally.</span>
      </DropZone>
    );
  }
  const { info } = state;
  const orientation = info.width && info.height ? classifyOrientation(info.width, info.height) : null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="flex h-48 w-full shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black sm:w-64">
        <video src={state.objectUrl} controls muted playsInline className="max-h-full max-w-full" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="truncate text-sm font-medium" title={state.name}>
          {state.name}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          <dt>Duration</dt>
          <dd className="font-medium text-neutral-900 dark:text-neutral-100">{formatDuration(info.durationSec)}</dd>
          <dt>Resolution</dt>
          <dd className="font-medium text-neutral-900 dark:text-neutral-100">
            {info.width && info.height ? `${info.width}×${info.height}` : "unknown"}
            {orientation && <span className="ml-1 font-normal text-neutral-500">({orientation})</span>}
          </dd>
          <dt>Size</dt>
          <dd className="font-medium text-neutral-900 dark:text-neutral-100">{formatBytes(info.sizeBytes)}</dd>
          <dt>Type</dt>
          <dd className="font-medium text-neutral-900 dark:text-neutral-100">{info.mimeType ?? "unknown"}</dd>
        </dl>
        <MetadataSource state={state} />
        <Progress state={state} />
        <div className="flex gap-2 pt-1">
          <label className="cursor-pointer text-xs font-medium text-violet-600 hover:underline">
            Replace
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" onClick={onClear} className="text-xs font-medium text-neutral-500 hover:underline">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

export function ThumbnailPicker({ state, onFile, onClear }: { state: UploadState | null; onFile: (f: File) => void; onClear: () => void }) {
  if (!state) {
    return (
      <DropZone accept="image/jpeg,image/png,image/webp" onFile={onFile} className="aspect-video">
        <span className="text-xl">🖼️</span>
        <span className="text-xs font-medium">Custom thumbnail</span>
        <span className="text-[11px] text-neutral-500">JPG/PNG, 1280×720, ≤ 2 MB for YouTube</span>
      </DropZone>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-neutral-100 dark:bg-neutral-800">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.objectUrl} alt="Thumbnail preview" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove thumbnail"
          className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white hover:bg-black/80"
        >
          ×
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-neutral-500">
          {state.info.width && state.info.height ? `${state.info.width}×${state.info.height} · ` : ""}
          {formatBytes(state.info.sizeBytes)}
        </span>
        <Progress state={state} />
      </div>
      {(state.info.sizeBytes ?? 0) > 2 * 1024 * 1024 && (
        <p className="text-xs text-amber-600">Over 2 MB — YouTube will reject this thumbnail.</p>
      )}
    </div>
  );
}
