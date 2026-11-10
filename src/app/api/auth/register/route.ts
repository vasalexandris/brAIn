import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { startSession } from "@/auth/session";
import { getDb } from "@/db";
import { EmailTakenError, createUser } from "@/db/repo";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return NextResponse.json({ error: "Δώσε ένα έγκυρο email." }, { status: 400 });
  }
  if (!name || name.length > 60) {
    return NextResponse.json({ error: "Πες μου πώς να σε φωνάζω (έως 60 χαρακτήρες)." }, { status: 400 });
  }
  if (password.length < 8 || password.length > 72) {
    return NextResponse.json({ error: "Ο κωδικός θέλει από 8 έως 72 χαρακτήρες." }, { status: 400 });
  }

  try {
    const user = await createUser(await getDb(), { email, name, passwordHash: await bcrypt.hash(password, 11) });
    await startSession(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return NextResponse.json({ error: "Υπάρχει ήδη λογαριασμός με αυτό το email." }, { status: 409 });
    }
    throw err;
  }
}
