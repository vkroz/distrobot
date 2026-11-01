import { NextResponse } from "next/server";
import { validateForPlatform } from "@/lib/platforms/validate";
import { isPlatformId, PLATFORM_IDS, type MediaInfo, type TargetContent } from "@/lib/types";


/**
 * POST { content: {title, caption, hashtags}, media?: MediaInfo, platforms?: PlatformId[] }
 * → { results: ValidationResult[] }
 */
export async function POST(req: Request) {
  let body: { content?: Partial<TargetContent>; media?: MediaInfo; platforms?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const platforms = body.platforms ?? [...PLATFORM_IDS];
  const invalid = platforms.filter((p) => !isPlatformId(p));
  if (invalid.length) return NextResponse.json({ error: `Unknown platforms: ${invalid.join(", ")}` }, { status: 400 });

  const content: TargetContent = {
    title: String(body.content?.title ?? ""),
    caption: String(body.content?.caption ?? ""),
    hashtags: Array.isArray(body.content?.hashtags) ? body.content.hashtags.map(String) : [],
  };
  const results = platforms.filter(isPlatformId).map((platform) => validateForPlatform({ platform, content, media: body.media }));
  return NextResponse.json({ results });
}
