/** Όλες οι ερωτήσεις προς τη βάση, σε ένα σημείο. */
import { randomUUID } from "node:crypto";
import type { Db } from "./index";
import type { Memory, MemoryKind } from "@/brain/memory";
import { normalizeValues, type BrainValues } from "@/brain/state";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: UserStatus;
  createdAt: Date;
}

export type UserStatus = "pending" | "approved" | "rejected";

export interface BrainState {
  values: BrainValues;
  impression: string;
  turnCount: number;
  updatedAt: Date | null;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

const toUser = (r: any): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  passwordHash: r.password_hash,
  status: r.status,
  createdAt: new Date(r.created_at),
});

export async function createUser(db: Db, input: { email: string; name: string; passwordHash: string }): Promise<User> {
  const rows = await db.query(
    `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [randomUUID(), input.email, input.name, input.passwordHash],
  );
  if (!rows.length) throw new EmailTakenError();
  return toUser(rows[0]);
}

export class EmailTakenError extends Error {}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const rows = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows.length ? toUser(rows[0]) : null;
}

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const rows = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows.length ? toUser(rows[0]) : null;
}

export async function listUsers(db: Db): Promise<User[]> {
  return (await db.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 500`)).map(toUser);
}

export async function setUserStatus(db: Db, id: string, status: UserStatus): Promise<boolean> {
  const rows = await db.query(`UPDATE users SET status = $2 WHERE id = $1 RETURNING id`, [id, status]);
  return rows.length > 0;
}

export async function loadBrainState(db: Db, userId: string): Promise<BrainState> {
  const rows = await db.query(`SELECT * FROM brain_states WHERE user_id = $1`, [userId]);
  if (!rows.length) return { values: normalizeValues(null), impression: "", turnCount: 0, updatedAt: null };
  const r = rows[0];
  return {
    values: normalizeValues(r.dims),
    impression: r.impression,
    turnCount: r.turn_count,
    updatedAt: new Date(r.updated_at),
  };
}

export async function saveBrainState(db: Db, userId: string, s: BrainState, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO brain_states (user_id, dims, impression, turn_count, updated_at)
     VALUES ($1, $2::text::jsonb, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET dims = EXCLUDED.dims, impression = EXCLUDED.impression,
           turn_count = EXCLUDED.turn_count, updated_at = EXCLUDED.updated_at`,
    [userId, JSON.stringify(s.values), s.impression, s.turnCount, now.toISOString()],
  );
}

export async function addMessage(
  db: Db,
  userId: string,
  role: "user" | "assistant",
  content: string,
  meta: unknown,
  at: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO messages (id, user_id, role, content, meta, created_at) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6)`,
    [randomUUID(), userId, role, content, JSON.stringify(meta ?? null), at.toISOString()],
  );
}

/** Τα τελευταία `limit` μηνύματα, με χρονολογική σειρά. */
export async function recentMessages(db: Db, userId: string, limit: number): Promise<StoredMessage[]> {
  const rows = await db.query(
    `SELECT id, role, content, created_at FROM messages WHERE user_id = $1 ORDER BY created_at DESC, role ASC LIMIT $2`,
    [userId, limit],
  );
  return rows
    .map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: new Date(r.created_at) }))
    .reverse();
}

const toMemory = (r: any): Memory => ({
  id: r.id,
  kind: r.kind as MemoryKind,
  content: r.content,
  importance: Number(r.importance),
  valence: Number(r.valence),
  embedding: r.embedding,
  recallCount: r.recall_count,
  createdAt: new Date(r.created_at),
  lastRecalledAt: new Date(r.last_recalled_at),
});

export async function listMemories(db: Db, userId: string): Promise<Memory[]> {
  return (await db.query(`SELECT * FROM memories WHERE user_id = $1`, [userId])).map(toMemory);
}

export async function insertMemory(
  db: Db,
  userId: string,
  m: { kind: MemoryKind; content: string; importance: number; valence: number; embedding: number[] },
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO memories (id, user_id, kind, content, importance, valence, embedding, created_at, last_recalled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $8)`,
    [randomUUID(), userId, m.kind, m.content, m.importance, m.valence, JSON.stringify(m.embedding), now.toISOString()],
  );
}

/** Αναθεώρηση υπάρχουσας ανάμνησης: νέο περιεχόμενο και συναίσθημα, ενισχυμένη ισχύς. */
export async function reviseMemory(
  db: Db,
  id: string,
  m: { content: string; importance: number; valence: number; embedding: number[] },
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE memories SET content = $2, importance = $3, valence = $4, embedding = $5::text::jsonb,
            recall_count = recall_count + 1, last_recalled_at = $6 WHERE id = $1`,
    [id, m.content, m.importance, m.valence, JSON.stringify(m.embedding), now.toISOString()],
  );
}

/** Ό,τι ανακαλείται, δυναμώνει. */
export async function reinforceMemories(db: Db, ids: string[], now: Date): Promise<void> {
  for (const id of ids) {
    await db.query(`UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = $2 WHERE id = $1`, [
      id,
      now.toISOString(),
    ]);
  }
}
