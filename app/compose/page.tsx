import type { Metadata } from "next";
import { Composer } from "@/components/compose/composer";

export const metadata: Metadata = { title: "Compose · Creator Publisher" };

export default async function ComposePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { draft } = await searchParams;
  const draftId = typeof draft === "string" && draft ? draft : null;
  // Key by draft id so switching drafts (or to a new post) remounts with fresh state.
  return <Composer key={draftId ?? "new"} draftId={draftId} />;
}
