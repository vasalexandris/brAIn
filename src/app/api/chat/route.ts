import { NextResponse } from "next/server";
import { currentUser } from "@/auth/session";
import { processTurn } from "@/brain/pipeline";
import { getDb } from "@/db";
import { getLlm } from "@/llm";

export const maxDuration = 60;

// Ένας γύρος τη φορά ανά χρήστη: δύο ταυτόχρονα μηνύματα θα έγραφαν το ένα πάνω στην κατάσταση του άλλου.
// (Ισχύει ανά διεργασία· για πολλούς servers θα χρειαστεί κλείδωμα στη βάση.)
const busy = new Set<string>();

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Δεν είσαι συνδεδεμένος." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Κενό μήνυμα." }, { status: 400 });
  if (message.length > 4000) return NextResponse.json({ error: "Πολύ μεγάλο μήνυμα." }, { status: 400 });

  if (busy.has(user.id)) {
    return NextResponse.json({ error: "Περίμενε να απαντήσω στο προηγούμενο." }, { status: 429 });
  }
  busy.add(user.id);
  try {
    const result = await processTurn({ db: await getDb(), llm: getLlm() }, user, message);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[brAIn] ο γύρος απέτυχε:", err);
    return NextResponse.json({ error: "Κάτι πήγε στραβά στη σκέψη μου. Δοκίμασε ξανά." }, { status: 502 });
  } finally {
    busy.delete(user.id);
  }
}
