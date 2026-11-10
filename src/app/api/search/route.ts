import { NextResponse } from "next/server";
import { isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { busy } from "@/brain/lock";
import { resolveSearch } from "@/brain/pipeline";
import { getDb } from "@/db";
import { getLlm } from "@/llm";

export const maxDuration = 60;

/** Ο συνομιλητής εγκρίνει ή αρνείται μια αναζήτηση που πρότεινε ο εγκέφαλος. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user || !isApproved(user)) return NextResponse.json({ error: "Δεν επιτρέπεται." }, { status: 403 });

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id || typeof body?.approve !== "boolean") return NextResponse.json({ error: "Λάθος αίτημα." }, { status: 400 });

  if (busy.has(user.id)) return NextResponse.json({ error: "Περίμενε μια στιγμή." }, { status: 429 });
  busy.add(user.id);
  try {
    const result = await resolveSearch({ db: await getDb(), llm: getLlm() }, user, id, body.approve);
    if (!result) return NextResponse.json({ error: "Η πρόταση αυτή δεν ισχύει πια." }, { status: 409 });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[brAIn] η αναζήτηση απέτυχε:", err);
    return NextResponse.json({ error: "Κάτι πήγε στραβά. Δοκίμασε ξανά." }, { status: 502 });
  } finally {
    busy.delete(user.id);
  }
}
