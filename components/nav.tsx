"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cx } from "./ui";

const LINKS = [
  { href: "/compose", label: "Compose" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
];

interface SessionInfo {
  authenticated: boolean;
  username: string | null;
  usingDefaultCredentials: boolean;
  usingDefaultSecret: boolean;
}

/** GET /api/session, refreshed on navigation (e.g. right after logging in). */
function useSession(pathname: string): SessionInfo | null {
  const [session, setSession] = useState<SessionInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => !cancelled && setSession(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);
  return session;
}

async function logout() {
  await fetch("/api/session", { method: "DELETE" }).catch(() => {});
  window.location.href = "/login";
}

export function Nav() {
  const pathname = usePathname();
  const session = useSession(pathname);
  if (pathname === "/login") return null;
  return (
    <nav className="flex flex-wrap items-center gap-1">
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              active
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white",
            )}
          >
            {l.label}
          </Link>
        );
      })}
      {session?.authenticated && (
        <span className="ml-2 flex items-center gap-2 border-l border-neutral-200 pl-3 dark:border-neutral-800">
          <span className="hidden text-xs text-neutral-500 sm:inline">{session.username}</span>
          <button
            type="button"
            onClick={logout}
            className="rounded-lg px-2 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Log out
          </button>
        </span>
      )}
    </nav>
  );
}

/** Thin warning when demo credentials or the dev session secret are in use. */
export function AuthWarningBanner() {
  const pathname = usePathname();
  const session = useSession(pathname);
  // The login page shows its own, more detailed warning.
  if (pathname === "/login" || !session || (!session.usingDefaultCredentials && !session.usingDefaultSecret)) return null;
  const parts = [
    session.usingDefaultCredentials && "demo login admin/admin",
    session.usingDefaultSecret && "development session secret",
  ].filter(Boolean);
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      ⚠ Using {parts.join(" and ")} — set <code>APP_USERNAME</code>, <code>APP_PASSWORD</code> and <code>APP_SESSION_SECRET</code> before
      exposing this app.
    </div>
  );
}
