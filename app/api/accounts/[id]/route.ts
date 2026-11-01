import { getDb } from "@/lib/db";
import { deleteAccount, getAccount } from "@/lib/db/repo";
import { errorJson, json } from "@/lib/http";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!getAccount(db, id)) return errorJson("Not found", 404);
  deleteAccount(db, id);
  return json({ ok: true });
}
