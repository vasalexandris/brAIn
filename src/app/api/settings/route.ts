import { NextResponse } from "next/server";
import { isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { getDb } from "@/db";
import { setAutoNews } from "@/db/repo";

/** Οι άδειες που δίνει ο συνομιλητής στον εγκέφαλο. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || !isApproved(user)) return NextResponse.json({ error: "Δεν επιτρέπεται." }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (typeof body?.autoNews !== "boolean") return NextResponse.json({ error: "Λάθος αίτημα." }, { status: 400 });

  await setAutoNews(await getDb(), user.id, body.autoNews, new Date());
  return NextResponse.json({ ok: true, autoNews: body.autoNews });
}
