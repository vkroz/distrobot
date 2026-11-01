import type { Metadata } from "next";
import { Composer } from "@/components/compose/composer";

export const metadata: Metadata = { title: "Compose · Creator Publisher" };

export default function ComposePage() {
  return <Composer />;
}
