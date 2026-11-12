/**
 * Βάση δεδομένων. Δύο τρόποι λειτουργίας με την ίδια SQL:
 *  - χωρίς DATABASE_URL: ενσωματωμένη Postgres (PGlite) σε αρχεία στο .data/
 *  - με DATABASE_URL:    κανονικός Postgres server (Supabase, Railway, δικός σας)
 */
import fs from "node:fs";
import path from "node:path";

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Έγκριση λογαριασμών: pending → approved | rejected (βλ. src/auth/access.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

-- Ένας εγκέφαλος ανά χρήστη: οι τιμές όλων των δεικτών και η εντύπωση για τον άνθρωπο.
CREATE TABLE IF NOT EXISTS brain_states (
  user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dims       jsonb NOT NULL,
  impression text NOT NULL DEFAULT '',
  turn_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

-- Η εικόνα του εγκεφάλου για τον εαυτό του: ποιος είναι, τι του αρέσει, τι τον χαλάει.
ALTER TABLE brain_states ADD COLUMN IF NOT EXISTS self_image text NOT NULL DEFAULT '';

-- Μόνιμη άδεια του χρήστη να διαβάζει τους τίτλους της ημέρας μία φορά τη μέρα χωρίς να ρωτά.
ALTER TABLE brain_states ADD COLUMN IF NOT EXISTS auto_news boolean NOT NULL DEFAULT false;

-- Όλη η συζήτηση. Στο meta κρατιέται η κατάσταση του εγκεφάλου μετά από κάθε μήνυμα.
CREATE TABLE IF NOT EXISTS messages (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  meta       jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user_time ON messages (user_id, created_at);

-- Αναζητήσεις στον κόσμο: τις προτείνει ο εγκέφαλος, τις εγκρίνει ο συνομιλητής.
-- status: pending → done | declined | failed
CREATE TABLE IF NOT EXISTS searches (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     text NOT NULL,
  query      text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_user_time ON searches (user_id, created_at);

-- Το κείμενο που βρέθηκε: μένει διαθέσιμο για λίγο, ώστε οι επόμενες ερωτήσεις να απαντώνται
-- από αυτό και όχι από τη φαντασία του μοντέλου.
ALTER TABLE searches ADD COLUMN IF NOT EXISTS material text;
-- Για μεγάλες σελίδες: το πλήρες κείμενο. Στο material μένει τότε μόνο η περιγραφή.
ALTER TABLE searches ADD COLUMN IF NOT EXISTS full_text text;

-- Μακρόχρονη μνήμη: μόνο ό,τι άξιζε να κρατηθεί.
CREATE TABLE IF NOT EXISTS memories (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  content          text NOT NULL,
  importance       real NOT NULL,
  valence          real NOT NULL,
  embedding        jsonb NOT NULL,
  recall_count     integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  last_recalled_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id);

-- Τρία επίπεδα βάθους για κάθε ανάμνηση: gist (μια εικόνα), content (τα βασικά), detail (τα πάντα).
-- topic: σε ποιο "ράφι" αρχειοθετείται. links: με ποιες άλλες αναμνήσεις συνδέεται.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS gist text NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic text NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
-- Βεβαιότητα 0–1: κάτω από 1 μόνο οι υποθέσεις, ώσπου να επαληθευτούν.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS certainty real NOT NULL DEFAULT 1;
`;

/** Ενσωματωμένη βάση. `dataDir` κενό = μόνο στη μνήμη (για tests). */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.exec(SCHEMA);
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query(sql, params as any[])).rows as T[];
    },
    close: () => pg.close(),
  };
}

async function createPostgresDb(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(SCHEMA);
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params as any[])).rows as T[];
    },
    close: () => pool.end(),
  };
}

// Ένα μόνο αντίγραφο ανά διεργασία, ακόμη και με το hot reload του Next.
const holder = globalThis as unknown as { __brainDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!holder.__brainDb) {
    const url = process.env.DATABASE_URL;
    const created = url ? createPostgresDb(url) : createPgliteDb(path.join(process.cwd(), ".data", "pglite"));
    holder.__brainDb = created;
    created.catch(() => {
      holder.__brainDb = undefined;
    });
  }
  return holder.__brainDb;
}
