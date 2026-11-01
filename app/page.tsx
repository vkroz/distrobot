import { listAdapters } from "@/lib/adapters";
import { LAST_REVIEWED, PLATFORM_RULES } from "@/lib/platforms/rules";
import { PLATFORM_IDS } from "@/lib/types";
import { ValidationPlayground } from "@/components/validation-playground";

export const dynamic = "force-dynamic";

function fmtBytes(b?: number) {
  if (!b) return "—";
  return b >= 1024 ** 3 ? `${b / 1024 ** 3} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}

function fmtDur(s?: number) {
  if (!s) return "—";
  if (s >= 3600) return `${s / 3600} h`;
  if (s >= 60) return `${s / 60} min`;
  return `${s} s`;
}

export default function Home() {
  const configured = new Map(listAdapters().map((a) => [a.platform, a.isConfigured()]));
  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-2xl font-semibold">Platform rules</h1>
        <p className="mt-1 text-sm text-neutral-500">Limits as of {LAST_REVIEWED}. Verify against each platform&apos;s docs.</p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-100 text-xs uppercase text-neutral-500 dark:bg-neutral-900">
              <tr>
                {["Platform", "Title", "Caption", "Hashtags", "Duration", "File size", "Aspect", "OAuth"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLATFORM_IDS.map((id) => {
                const r = PLATFORM_RULES[id];
                return (
                  <tr key={id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2 font-medium">
                      <a href={r.docsUrl} className="hover:underline" target="_blank" rel="noreferrer">{r.displayName}</a>
                    </td>
                    <td className="px-3 py-2">{r.title.supported ? r.title.maxLength : "—"}</td>
                    <td className="px-3 py-2">{r.caption.maxLength?.toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {r.hashtags.max ?? "∞"}
                      {r.hashtags.recommendedMax ? ` (rec. ${r.hashtags.recommendedMax})` : ""}
                      {r.hashtags.placement === "tags" ? " tags" : ""}
                    </td>
                    <td className="px-3 py-2">{fmtDur(r.video.minDurationSec)} – {fmtDur(r.video.maxDurationSec)}</td>
                    <td className="px-3 py-2">{fmtBytes(r.video.maxFileSizeBytes)}</td>
                    <td className="px-3 py-2">{r.video.recommendedAspectRatios.join(", ")}</td>
                    <td className="px-3 py-2">
                      {configured.get(id) ? <span className="text-green-600">configured</span> : <span className="text-neutral-400">not set</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Validation playground</h2>
        <p className="mt-1 text-sm text-neutral-500">Draft a post and see per-platform errors, warnings and suggested adaptations.</p>
        <ValidationPlayground />
      </section>
    </div>
  );
}
