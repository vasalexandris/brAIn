import { NextResponse } from "next/server";
import { isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { getDb } from "@/db";
import { setAutoNews, setAutoSearch } from "@/db/repo";

/** Οι άδειες που δίνει ο συνομιλητής στον εγκέφαλο. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || !isApproved(user)) return NextResponse.json({ error: "Δεν επιτρέπεται." }, { status: 403 });

  const body = await req.json().catch(() => null);
  const news = typeof body?.autoNews === "boolean" ? body.autoNews : undefined;
  const search = typeof body?.autoSearch === "boolean" ? body.autoSearch : undefined;
  if (news === undefined && search === undefined) return NextResponse.json({ error: "Λάθος αίτημα." }, { status: 400 });

  const db = await getDb();
  const now = new Date();
  if (news !== undefined) await setAutoNews(db, user.id, news, now);
  if (search !== undefined) await setAutoSearch(db, user.id, search, now);
  return NextResponse.json({ ok: true, autoNews: news, autoSearch: search });
}
