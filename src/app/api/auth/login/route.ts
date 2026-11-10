import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { startSession } from "@/auth/session";
import { getDb } from "@/db";
import { findUserByEmail } from "@/db/repo";

// Ώστε η απάντηση να παίρνει τον ίδιο χρόνο είτε υπάρχει ο λογαριασμός είτε όχι.
const DUMMY_HASH = bcrypt.hashSync("no-such-user", 11);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const user = email ? await findUserByEmail(await getDb(), email) : null;
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    return NextResponse.json({ error: "Λάθος email ή κωδικός." }, { status: 401 });
  }
  await startSession(user.id);
  return NextResponse.json({ ok: true });
}
