import type { Metadata } from "next";
import { connection } from "next/server";
import { DEFAULT_PASSWORD, DEFAULT_USERNAME, getAuthConfig, safeNext } from "@/lib/auth";
import { Card, btn, cx, inputCls } from "@/components/ui";

export const metadata: Metadata = { title: "Log in · Creator Publisher" };

/** Plain HTML form → POST /api/session, so login works without JavaScript. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); // auth config comes from runtime env
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  const cfg = getAuthConfig();

  return (
    <div className="mx-auto mt-8 max-w-sm space-y-4 sm:mt-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
        <p className="mt-1 text-sm text-neutral-500">Creator Publisher admin</p>
      </div>

      {cfg.disabledReason && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {cfg.disabledReason}
        </div>
      )}
      {!cfg.disabledReason && cfg.usingDefaultCredentials && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-semibold">Demo login in use</p>
          <p className="mt-0.5">
            Username <code className="font-mono font-semibold">{DEFAULT_USERNAME}</code>, password{" "}
            <code className="font-mono font-semibold">{DEFAULT_PASSWORD}</code>. Set <code>APP_USERNAME</code>, <code>APP_PASSWORD</code> and{" "}
            <code>APP_SESSION_SECRET</code> before exposing this app.
          </p>
        </div>
      )}

      <Card className="p-6">
        <form method="post" action="/api/session" className="space-y-4">
          <input type="hidden" name="next" value={next} />
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Username</span>
            <input name="username" required autoComplete="username" autoFocus className={inputCls} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Password</span>
            <input name="password" type="password" required autoComplete="current-password" className={inputCls} />
          </label>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button type="submit" className={cx(btn.primary, "w-full")} disabled={!!cfg.disabledReason}>
            Log in
          </button>
        </form>
      </Card>
    </div>
  );
}
