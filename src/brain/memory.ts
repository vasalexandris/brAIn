/**
 * Μνήμη που ξεχνά.
 *
 * Κάθε ανάμνηση έχει "σημασία" (0–100) που ορίζεται τη στιγμή της καταγραφής και
 * ενισχύεται από τη συναισθηματική φόρτιση της στιγμής. Η ισχύς της φθίνει με τον
 * χρόνο· όσο πιο σημαντική και όσο πιο συχνά ανακαλείται, τόσο πιο αργά.
 */

export type MemoryKind = "user_fact" | "episode" | "knowledge" | "opinion";

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  user_fact: "για τον συνομιλητή",
  episode: "κάτι που συνέβη μεταξύ μας",
  knowledge: "κάτι που έμαθα",
  opinion: "η γνώμη μου",
};

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number; // 0–100
  valence: number; // −1…+1, το συναίσθημα με το οποίο δέθηκε
  embedding: number[];
  recallCount: number;
  createdAt: Date;
  lastRecalledAt: Date;
}

/** Κάτω από αυτή τη σημασία, το ερέθισμα δεν γράφεται καν στη μνήμη. */
export const MIN_IMPORTANCE = 15;
/** Κάτω από αυτή την ισχύ, η ανάμνηση θεωρείται ξεχασμένη. */
export const FORGOTTEN_BELOW = 0.05;
/** Πάνω από αυτή την ομοιότητα, μια νέα ανάμνηση αναθεωρεί την παλιά αντί να προστεθεί. */
export const SAME_MEMORY_SIMILARITY = 0.92;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Χρόνος ημιζωής της ανάμνησης, σε ημέρες. */
export function stabilityDays(importance: number, recallCount: number): number {
  const i = Math.min(100, Math.max(0, importance)) / 100;
  return (0.5 + i * i * 60) * (1 + 0.5 * recallCount);
}

/** Τρέχουσα ισχύς 0–1. Ό,τι μας σημάδεψε (σημασία ≥ 85) δεν σβήνει ποτέ εντελώς. */
export function strength(m: Pick<Memory, "importance" | "recallCount" | "lastRecalledAt">, now: Date): number {
  const ageDays = Math.max(0, now.getTime() - m.lastRecalledAt.getTime()) / DAY_MS;
  const s = Math.pow(0.5, ageDays / stabilityDays(m.importance, m.recallCount));
  return m.importance >= 85 ? Math.max(s, 0.3) : s;
}

/** Η συναισθηματική φόρτιση (0–1) "καρφώνει" την ανάμνηση πιο βαθιά. */
export function encodeImportance(proposed: number, arousal: number): number {
  return Math.round(Math.min(100, Math.max(0, proposed * (0.75 + 0.6 * arousal))));
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface Recalled {
  memory: Memory;
  score: number;
  similarity: number;
  strength: number;
}

/**
 * Ανάκληση: τι "έρχεται στο μυαλό" με αφορμή το τρέχον μήνυμα.
 * Μετρούν η συνάφεια, η ισχύς, η σημασία, και η διάθεση της στιγμής
 * (όταν είμαστε θυμωμένοι θυμόμαστε πιο εύκολα τα άσχημα).
 */
export function recall(
  memories: Memory[],
  cue: number[],
  moodValence: number,
  now: Date,
  limit = 6,
): Recalled[] {
  const alive = memories
    .map((memory) => {
      const s = strength(memory, now);
      const similarity = cosine(cue, memory.embedding);
      const congruence = 1 - Math.abs(memory.valence - moodValence) / 2;
      const score = similarity * 0.6 + s * 0.2 + (memory.importance / 100) * 0.1 + congruence * 0.1;
      return { memory, score, similarity, strength: s };
    })
    .filter((r) => r.strength >= FORGOTTEN_BELOW);

  const byScore = [...alive].sort((a, b) => b.score - a.score).slice(0, limit);
  // Τα πολύ βασικά (π.χ. το όνομά του) είναι πάντα διαθέσιμα, άσχετα με το θέμα.
  const core = [...alive]
    .sort((a, b) => b.memory.importance * b.strength - a.memory.importance * a.strength)
    .slice(0, 2);
  for (const c of core) if (!byScore.includes(c)) byScore.push(c);
  return byScore;
}
