"use client";

import { useState, type KeyboardEvent } from "react";
import { normalizeHashtags } from "@/lib/platforms/text";
import { cx } from "../ui";

/** Chip input for hashtags. Enter, comma or space commits; Backspace on empty removes the last. */
export function HashtagInput({
  value,
  onChange,
  placeholder = "Add hashtag…",
  max,
  recommendedMax,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  max?: number;
  recommendedMax?: number;
}) {
  const [draft, setDraft] = useState("");

  const commit = (text: string) => {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    if (parts.length) onChange(normalizeHashtags([...value, ...parts]));
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const over = max !== undefined && value.length > max;
  const soft = !over && recommendedMax !== undefined && value.length > recommendedMax;

  return (
    <div
      className={cx(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5 text-sm shadow-sm focus-within:ring-2 dark:bg-neutral-950",
        over
          ? "border-red-400 focus-within:ring-red-100 dark:focus-within:ring-red-950"
          : "border-neutral-300 focus-within:border-neutral-500 focus-within:ring-neutral-200 dark:border-neutral-700 dark:focus-within:ring-neutral-800",
      )}
    >
      {value.map((tag, i) => (
        <span
          key={tag}
          className={cx(
            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
            max !== undefined && i >= max
              ? "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-300"
              : "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
          )}
        >
          #{tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-neutral-400"
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft && commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[\s,]/.test(text)) {
            e.preventDefault();
            commit(draft + text);
          }
        }}
      />
      {(over || soft) && (
        <span className={cx("ml-auto text-xs", over ? "text-red-600" : "text-amber-600")}>
          {value.length}/{over ? max : recommendedMax}
        </span>
      )}
    </div>
  );
}
