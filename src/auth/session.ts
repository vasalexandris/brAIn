import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { findUserById, type User } from "@/db/repo";

const COOKIE = "brain_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 μέρες

let secret: Uint8Array | undefined;

function getSecret(): Uint8Array {
  if (secret) return secret;
  let value = process.env.AUTH_SECRET;
  if (!value) {
    if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
      throw new Error("Λείπει το AUTH_SECRET. Ορίστε το πριν τρέξετε σε production.");
    }
    // Τοπικά: δημιουργείται μία φορά και φυλάσσεται δίπλα στην ενσωματωμένη βάση.
    const file = path.join(process.cwd(), ".data", "auth-secret");
    if (fs.existsSync(file)) {
      value = fs.readFileSync(file, "utf8");
    } else {
      value = randomBytes(32).toString("hex");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value, { mode: 0o600 });
    }
  }
  secret = new TextEncoder().encode(value);
  return secret;
}

export async function startSession(userId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(getSecret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** Ο συνδεδεμένος χρήστης, ή null. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return findUserById(await getDb(), payload.sub);
  } catch {
    return null;
  }
}
