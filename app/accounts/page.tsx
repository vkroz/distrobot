import type { Metadata } from "next";
import { AccountsView } from "@/components/accounts/accounts-view";

export const metadata: Metadata = { title: "Accounts · Creator Publisher" };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { connected, error } = await searchParams;
  return (
    <AccountsView
      connected={typeof connected === "string" ? connected : null}
      error={typeof error === "string" ? error : null}
    />
  );
}
