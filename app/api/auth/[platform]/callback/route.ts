import { redirect } from "next/navigation";
import { getAdapter } from "@/lib/adapters";
import { getDb } from "@/lib/db";
import { consumeOAuthState, upsertAccount } from "@/lib/db/repo";
import { errorJson } from "@/lib/http";
import { isPlatformId } from "@/lib/types";

/** OAuth redirect target: verify state, exchange the code, store the account. */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isPlatformId(platform)) return errorJson("Unknown platform", 404);
  const params = new URL(req.url).searchParams;
  const db = getDb();
  const saved = params.get("state") ? consumeOAuthState(db, params.get("state")!, platform) : null;
  const back = saved?.returnTo ?? "/accounts";
  const fail = (msg: string) => redirect(`${back}?error=${encodeURIComponent(msg)}`);

  if (!saved) fail("Authorization expired or invalid state. Please try again.");
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) fail(providerError);
  const code = params.get("code");
  if (!code) fail("Missing authorization code");

  let ok = false;
  let message = "";
  try {
    const creds = await getAdapter(platform).handleCallback({
      code: code!,
      redirectUri: saved!.redirectUri,
      codeVerifier: saved!.codeVerifier ?? undefined,
    });
    upsertAccount(db, creds);
    ok = true;
  } catch (err) {
    message = (err as Error).message;
  }
  // redirect() throws, so call it outside try/catch.
  if (!ok) fail(message || "Authorization failed");
  redirect(`${back}?connected=${platform}`);
}
