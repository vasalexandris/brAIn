import { NextResponse } from "next/server";
import { isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { busy } from "@/brain/lock";
import { DailyLimitError, processTurn } from "@/brain/pipeline";
import { getDb } from "@/db";
import { getLlm } from "@/llm";

export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Δεν είσαι συνδεδεμένος." }, { status: 401 });

  if (!isApproved(user)) return NextResponse.json({ error: "Ο λογαριασμός σου δεν έχει εγκριθεί." }, { status: 403 });

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
    if (err instanceof DailyLimitError) {
      return NextResponse.json({ error: "Μιλήσαμε πολύ σήμερα. Ας συνεχίσουμε αύριο." }, { status: 429 });
    }
    console.error("[brAIn] ο γύρος απέτυχε:", err);
    return NextResponse.json({ error: "Κάτι πήγε στραβά στη σκέψη μου. Δοκίμασε ξανά." }, { status: 502 });
  } finally {
    busy.delete(user.id);
  }
}
