import { redirect } from "next/navigation";
import { AdapterError, createPkcePair, createState, getAdapter } from "@/lib/adapters";
import { getDb } from "@/lib/db";
import { createOAuthState } from "@/lib/db/repo";
import { appUrl, errorJson, safeReturnTo } from "@/lib/http";
import { isPlatformId } from "@/lib/types";

/** Begin OAuth: store state (+PKCE verifier) and redirect to the provider. */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!isPlatformId(platform)) return errorJson("Unknown platform", 404);
  const adapter = getAdapter(platform);
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get("returnTo"));
  const redirectUri = `${appUrl(req)}/api/auth/${platform}/callback`;
  const state = createState();
  const pkce = adapter.capabilities.pkce ? createPkcePair() : null;

  let url: string;
  try {
    url = adapter.getAuthUrl({ state, redirectUri, codeChallenge: pkce?.challenge });
  } catch (err) {
    const msg = err instanceof AdapterError ? err.message : "Could not start authorization";
    redirect(`${returnTo}?error=${encodeURIComponent(msg)}`);
  }
  createOAuthState(getDb(), { state, platform, codeVerifier: pkce?.verifier, redirectUri, returnTo });
  redirect(url);
}
