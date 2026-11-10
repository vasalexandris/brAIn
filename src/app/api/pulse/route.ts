import { NextResponse } from "next/server";
import { isApproved } from "@/auth/access";
import { currentUser } from "@/auth/session";
import { busy } from "@/brain/lock";
import { pulse } from "@/brain/pipeline";
import { getDb } from "@/db";
import { getLlm } from "@/llm";

export const maxDuration = 60;

/** Καλείται από τη σελίδα της συνομιλίας όσο ο συνομιλητής σωπαίνει. */
export async function POST() {
  const user = await currentUser();
  if (!user || !isApproved(user)) return NextResponse.json({ error: "Δεν επιτρέπεται." }, { status: 403 });
  if (busy.has(user.id)) return NextResponse.json({ message: null, values: null, nextInSec: 30 });

  busy.add(user.id);
  try {
    return NextResponse.json(await pulse({ db: await getDb(), llm: getLlm() }, user));
  } catch (err) {
    console.error("[brAIn] ο σφυγμός απέτυχε:", err);
    return NextResponse.json({ message: null, values: null, nextInSec: 300 });
  } finally {
    busy.delete(user.id);
  }
}
