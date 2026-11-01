import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Creator Publisher",
  description: "Publish one video to every platform from one place.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <span className="font-semibold">Creator Publisher</span>
            <span className="text-xs text-neutral-500">MVP · stage 1</span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
