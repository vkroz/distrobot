import { getDb } from "@/lib/db";
import { errorJson, json } from "@/lib/http";
import { getPostSummary } from "@/lib/services/posts";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const post = getPostSummary(getDb(), id);
  return post ? json({ post }) : errorJson("Not found", 404);
}
