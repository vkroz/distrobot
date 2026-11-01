import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/dashboard";

export const metadata: Metadata = { title: "Dashboard · Creator Publisher" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { post, view } = await searchParams;
  return <Dashboard highlight={typeof post === "string" ? post : null} initialView={view === "calendar" ? "calendar" : "list"} />;
}
