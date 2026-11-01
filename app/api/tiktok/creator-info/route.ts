import { connection } from "next/server";
import { AdapterError, getAdapter } from "@/lib/adapters";
import type { TikTokAdapter } from "@/lib/adapters/platforms/tiktok";
import { getDb } from "@/lib/db";
import { listAccounts } from "@/lib/db/repo";
import { json } from "@/lib/http";
import { dryRunModeFromEnv, shouldDryRun } from "@/lib/jobs/runner";
import { MOCK_CREATOR_INFO } from "@/lib/platforms/tiktok";

/**
 * Creator info for the TikTok posting screen (TikTok requires showing it and using its
 * privacy options / interaction limits). Real `creator_info/query` when a TikTok account is
 * connected and TikTok isn't in dry-run; otherwise a clearly-labelled mock.
 * → { source: "api" | "mock", reason?, account?, creator } | 502 { source: "error", error }
 */
export async function GET() {
  await connection();
  const adapter = getAdapter("tiktok") as TikTokAdapter;
  if (shouldDryRun(adapter, { dryRun: false }, dryRunModeFromEnv())) {
    return json({ source: "mock", reason: "TikTok runs in dry-run mode", creator: MOCK_CREATOR_INFO });
  }
  const account = listAccounts(getDb(), "tiktok")[0];
  if (!account) {
    return json({ source: "mock", reason: "No TikTok account connected", creator: MOCK_CREATOR_INFO });
  }
  try {
    const creator = await adapter.queryCreatorInfo(account);
    return json({ source: "api", account: { id: account.id, displayName: account.displayName }, creator });
  } catch (err) {
    const message = err instanceof AdapterError ? err.message : "Could not reach TikTok";
    // TikTok also uses this call to signal the creator can't post right now (e.g. daily cap).
    return json({ source: "error", error: message, creator: null }, 502);
  }
}
