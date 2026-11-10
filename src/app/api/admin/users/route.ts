import { NextResponse } from "next/server";
import { isAdmin } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { getDb } from "@/db";
import { setUserStatus, type UserStatus } from "@/db/repo";

const STATUSES: UserStatus[] = ["pending", "approved", "rejected"];

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "Δεν επιτρέπεται." }, { status: 403 });

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const status = body?.status as UserStatus;
  if (!id || !STATUSES.includes(status)) return NextResponse.json({ error: "Λάθος αίτημα." }, { status: 400 });

  const found = await setUserStatus(await getDb(), id, status);
  if (!found) return NextResponse.json({ error: "Ο χρήστης δεν βρέθηκε." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
