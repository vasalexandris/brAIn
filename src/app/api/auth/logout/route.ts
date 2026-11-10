import { NextResponse } from "next/server";
import { endSession } from "@/auth/session";

export async function POST() {
  await endSession();
  return NextResponse.json({ ok: true });
}
