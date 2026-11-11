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
  selfImage: string;
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
  if (!rows.length) return { values: normalizeValues(null), impression: "", selfImage: "", turnCount: 0, updatedAt: null };
  const r = rows[0];
  return {
    values: normalizeValues(r.dims),
    impression: r.impression,
    selfImage: r.self_image,
    turnCount: r.turn_count,
    updatedAt: new Date(r.updated_at),
  };
}

export async function saveBrainState(db: Db, userId: string, s: BrainState, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO brain_states (user_id, dims, impression, turn_count, updated_at, self_image)
     VALUES ($1, $2::text::jsonb, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE
       SET dims = EXCLUDED.dims, impression = EXCLUDED.impression, self_image = EXCLUDED.self_image,
           turn_count = EXCLUDED.turn_count, updated_at = EXCLUDED.updated_at`,
    [userId, JSON.stringify(s.values), s.impression, s.turnCount, now.toISOString(), s.selfImage],
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

/** Πόσα μηνύματα του χρήστη, ή πόσα μηνύματα πρωτοβουλίας του εγκεφάλου, γράφτηκαν από τότε. */
export async function countSince(db: Db, userId: string, kind: "user" | "proactive", since: Date): Promise<number> {
  const filter = kind === "user" ? `role = 'user'` : `role = 'assistant' AND meta->>'proactive' = 'true'`;
  const rows = await db.query(
    `SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND created_at >= $2 AND ${filter}`,
    [userId, since.toISOString()],
  );
  return rows[0].n;
}

const toMemory = (r: any): Memory => ({
  id: r.id,
  kind: r.kind as MemoryKind,
  content: r.content,
  gist: r.gist ?? "",
  detail: r.detail ?? "",
  topic: r.topic ?? "",
  links: Array.isArray(r.links) ? r.links : [],
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

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
  gist?: string;
  detail?: string;
  topic?: string;
  links?: string[];
  importance: number;
  valence: number;
  embedding: number[];
}

export async function insertMemory(db: Db, userId: string, m: MemoryInput, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO memories (id, user_id, kind, content, importance, valence, embedding, created_at, last_recalled_at,
                           gist, detail, topic, links)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $8, $9, $10, $11, $12::text::jsonb)`,
    [
      randomUUID(),
      userId,
      m.kind,
      m.content,
      m.importance,
      m.valence,
      JSON.stringify(m.embedding),
      now.toISOString(),
      m.gist ?? "",
      m.detail ?? "",
      m.topic ?? "",
      JSON.stringify(m.links ?? []),
    ],
  );
}

/**
 * Αναθεώρηση υπάρχουσας ανάμνησης: νέο περιεχόμενο και συναίσθημα, ενισχυμένη ισχύς.
 * Ό,τι επίπεδο δεν δοθεί εκ νέου, μένει όπως ήταν.
 */
export async function reviseMemory(db: Db, id: string, m: Omit<MemoryInput, "kind" | "links">, now: Date): Promise<void> {
  await db.query(
    `UPDATE memories SET content = $2, importance = $3, valence = $4, embedding = $5::text::jsonb,
            recall_count = recall_count + 1, last_recalled_at = $6,
            gist = COALESCE(NULLIF($7, ''), gist), detail = COALESCE(NULLIF($8, ''), detail),
            topic = COALESCE(NULLIF($9, ''), topic)
      WHERE id = $1`,
    [id, m.content, m.importance, m.valence, JSON.stringify(m.embedding), now.toISOString(), m.gist ?? "", m.detail ?? "", m.topic ?? ""],
  );
}

export async function deleteMemories(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) await db.query(`DELETE FROM memories WHERE id = $1`, [id]);
}

/**
 * Ό,τι ανακαλείται, δυναμώνει — σταδιακά: κάθε ανάκληση μετακινεί το "πότε το θυμήθηκα τελευταία"
 * όσο λέει ο καλών (βλ. rehearse στο memory.ts), όχι κατευθείαν στο τώρα.
 */
export async function reinforceMemories(db: Db, items: { id: string; lastRecalledAt: Date }[]): Promise<void> {
  for (const item of items) {
    await db.query(`UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = $2 WHERE id = $1`, [
      item.id,
      item.lastRecalledAt.toISOString(),
    ]);
  }
}

// ------------------------------------------------------------- Αναζητήσεις

export interface Search {
  id: string;
  source: "wikipedia" | "news" | "headlines" | "web";
  query: string;
  status: "pending" | "done" | "declined" | "failed";
  createdAt: Date;
}

const toSearch = (r: any): Search => ({
  id: r.id,
  source: r.source,
  query: r.query,
  status: r.status,
  createdAt: new Date(r.created_at),
});

export async function createSearch(db: Db, userId: string, source: Search["source"], query: string, now: Date): Promise<Search> {
  const rows = await db.query(
    `INSERT INTO searches (id, user_id, source, query, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [randomUUID(), userId, source, query, now.toISOString()],
  );
  return toSearch(rows[0]);
}

/** Η πιο πρόσφατη αναζήτηση του χρήστη, σε όποια κατάσταση κι αν είναι. */
export async function latestSearch(db: Db, userId: string): Promise<Search | null> {
  const rows = await db.query(`SELECT * FROM searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows.length ? toSearch(rows[0]) : null;
}

/** Κλείνει μια εκκρεμή αναζήτηση. Επιστρέφει null αν δεν ήταν εκκρεμής (π.χ. διπλό κλικ). */
export async function closeSearch(db: Db, userId: string, id: string, status: Search["status"]): Promise<Search | null> {
  const rows = await db.query(
    `UPDATE searches SET status = $3 WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
    [id, userId, status],
  );
  return rows.length ? toSearch(rows[0]) : null;
}

export async function setSearchStatus(db: Db, id: string, status: Search["status"]): Promise<void> {
  await db.query(`UPDATE searches SET status = $2 WHERE id = $1`, [id, status]);
}

export async function countSearchesSince(db: Db, userId: string, since: Date): Promise<number> {
  const rows = await db.query(
    `SELECT count(*)::int AS n FROM searches WHERE user_id = $1 AND created_at >= $2 AND status IN ('done', 'failed')`,
    [userId, since.toISOString()],
  );
  return rows[0].n;
}

export async function saveSearchMaterial(db: Db, id: string, material: string): Promise<void> {
  await db.query(`UPDATE searches SET material = $2 WHERE id = $1`, [id, material]);
}

/** Ό,τι διάβασε πρόσφατα: το υλικό των αναζητήσεων που ολοκληρώθηκαν από το `since` και μετά. */
export async function recentMaterial(db: Db, userId: string, since: Date): Promise<{ query: string; text: string; at: Date }[]> {
  const rows = await db.query(
    `SELECT query, material, created_at FROM searches
      WHERE user_id = $1 AND status = 'done' AND material IS NOT NULL AND created_at >= $2
      ORDER BY created_at DESC LIMIT 2`,
    [userId, since.toISOString()],
  );
  return rows.map((r) => ({ query: r.query, text: r.material, at: new Date(r.created_at) }));
}
