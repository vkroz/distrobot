"use client";

import { useCallback, useEffect, useState } from "react";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import type { PlatformStatus, PublicAccount } from "@/lib/services/posts";
import { isPlatformId } from "@/lib/types";
import { Badge, Card, PlatformIcon, btn, cx, formatDateTime } from "../ui";

const MODE_TEXT: Record<string, { tone: string; text: string }> = {
  on: {
    tone: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
    text: "Dry-run mode is ON (DRY_RUN=true): every publish is simulated with a fake result link. Nothing is posted.",
  },
  auto: {
    tone: "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
    text: "Auto dry-run: platforms without OAuth credentials are simulated; configured platforms publish for real. Set DRY_RUN=true or false to force a mode.",
  },
  off: {
    tone: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    text: "Live mode (DRY_RUN=false): publishes go to the real platforms. Unconfigured platforms will fail.",
  },
};

function AccountRow({ account, onDisconnect, busy }: { account: PublicAccount; onDisconnect: () => void; busy: boolean }) {
  const expired = account.expiresAt && Date.parse(account.expiresAt) < Date.now();
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-950">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{account.displayName}</p>
        <p className="truncate text-xs text-neutral-500">
          Connected {formatDateTime(account.createdAt)}
          {account.expiresAt && (
            <span className={cx(expired && "text-amber-600")}>
              {" "}
              · token {expired ? "expired (auto-refreshes)" : `expires ${formatDateTime(account.expiresAt)}`}
            </span>
          )}
        </p>
      </div>
      <button type="button" className={btn.small} onClick={onDisconnect} disabled={busy}>
        {busy ? "…" : "Disconnect"}
      </button>
    </li>
  );
}

export function AccountsView({ connected, error }: { connected: string | null; error: string | null }) {
  const [data, setData] = useState<{ dryRunMode: string; platforms: PlatformStatus[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(
    error
      ? { ok: false, text: error }
      : connected
        ? { ok: true, text: `Connected ${isPlatformId(connected) ? PLATFORM_RULES[connected].displayName : connected}.` }
        : null,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load accounts (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    // Drop ?connected / ?error from the URL so a refresh doesn't repeat the message.
    if (connected || error) window.history.replaceState(null, "", "/accounts");
  }, [load, connected, error]);

  async function disconnect(id: string) {
    if (!confirm("Disconnect this account? Scheduled jobs for it will fail until you reconnect.")) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      setFlash(res.ok ? { ok: true, text: "Account disconnected." } : { ok: false, text: `Disconnect failed (${res.status})` });
    } finally {
      setBusy(null);
      load();
    }
  }

  const mode = data ? (MODE_TEXT[data.dryRunMode] ?? MODE_TEXT.auto) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <p className="mt-1 text-sm text-neutral-500">Connect the channels you publish to.</p>
      </div>

      {flash && (
        <div
          className={cx(
            "flex items-start justify-between gap-3 rounded-lg px-4 py-3 text-sm",
            flash.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
          )}
        >
          <span>{flash.text}</span>
          <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
            ×
          </button>
        </div>
      )}
      {mode && <div className={cx("rounded-lg border px-4 py-3 text-sm", mode.tone)}>{mode.text}</div>}
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(data?.platforms ?? []).map((p) => (
          <Card key={p.platform} className="flex flex-col p-5">
            <div className="flex items-center gap-3">
              <PlatformIcon platform={p.platform} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{p.displayName}</p>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {p.configured ? <Badge tone="green">Configured</Badge> : <Badge>Not configured</Badge>}
                  {p.dryRun && <Badge tone="amber">Dry-run</Badge>}
                  {p.capabilities.nativeScheduling && <Badge tone="violet">Native scheduling</Badge>}
                </div>
              </div>
            </div>

            <div className="mt-4 flex-1 space-y-3">
              {!p.configured && (
                <div className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                  <p>
                    Add OAuth credentials to <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">.env</code> to enable real publishing:
                  </p>
                  <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-2 text-[11px] dark:bg-neutral-950">
                    {p.envVars.map((e) => `${e}=…`).join("\n")}
                  </pre>
                  <p>
                    Redirect URI to register: <code className="break-all">{p.redirectUri}</code>
                  </p>
                  <p>Until then, posts to {p.displayName} run as dry-run simulations.</p>
                </div>
              )}
              {p.accounts.length > 0 ? (
                <ul className="space-y-2">
                  {p.accounts.map((a) => (
                    <AccountRow key={a.id} account={a} busy={busy === a.id} onDisconnect={() => disconnect(a.id)} />
                  ))}
                </ul>
              ) : (
                p.configured && <p className="text-xs text-neutral-500">No account connected yet.</p>
              )}
            </div>

            <div className="mt-4">
              {p.configured ? (
                <a href={`/api/auth/${p.platform}/start?returnTo=/accounts`} className={cx(btn.primary, "w-full")}>
                  {p.accounts.length ? "Connect another / reconnect" : `Connect ${p.displayName}`}
                </a>
              ) : (
                <button type="button" className={cx(btn.secondary, "w-full")} disabled title="Set the env vars above and restart the server">
                  Connect {p.displayName}
                </button>
              )}
            </div>
          </Card>
        ))}
        {!data &&
          !loadError &&
          [0, 1, 2].map((i) => <div key={i} className="h-48 animate-pulse rounded-xl bg-neutral-200/60 dark:bg-neutral-800/60" />)}
      </div>
    </div>
  );
}
