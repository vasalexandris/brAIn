/**
 * Μνήμη που ξεχνά.
 *
 * Κάθε ανάμνηση έχει "σημασία" (0–100) που ορίζεται τη στιγμή της καταγραφής και
 * ενισχύεται από τη συναισθηματική φόρτιση της στιγμής. Η ισχύς της φθίνει με τον
 * χρόνο· όσο πιο σημαντική και όσο πιο συχνά ανακαλείται, τόσο πιο αργά.
 */

export type MemoryKind = "user_fact" | "episode" | "knowledge" | "opinion" | "self" | "goal" | "lesson" | "hypothesis";

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  user_fact: "για τον συνομιλητή",
  episode: "κάτι που συνέβη μεταξύ μας",
  knowledge: "κάτι που έμαθα",
  opinion: "η γνώμη μου",
  self: "για τον εαυτό μου",
  goal: "κάτι που θέλω",
  lesson: "μάθημα για μένα",
  hypothesis: "υπόθεσή μου, ανεπιβεβαίωτη",
};

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** Επίπεδο 2: τα βασικά, σε μία ή δύο προτάσεις. */
  content: string;
  /** Επίπεδο 1: μια στιγμιαία εικόνα — «ξέρω ότι κάτι ξέρω γι' αυτό». */
  gist: string;
  /** Επίπεδο 3: όλες οι λεπτομέρειες. */
  detail: string;
  /** Το "ράφι" όπου αρχειοθετείται (π.χ. αθλητικά, επικαιρότητα, ο συνομιλητής). */
  topic: string;
  /** Με ποιες άλλες αναμνήσεις συνδέεται. */
  links: string[];
  /** Πόσο σίγουρη είναι (0–1). Κάτω από 1 μόνο οι υποθέσεις, ώσπου να επαληθευτούν. */
  certainty: number;
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
export const SAME_MEMORY_SIMILARITY = 0.88;

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

/**
 * Πόσο βαθιά φτάνει η ανάμνηση αυτή τη στιγμή.
 *   3 — φρέσκια: όλες οι λεπτομέρειες
 *   2 — μένουν τα βασικά
 *   1 — μόνο μια εικόνα: ξέρω ότι το ξέρω, όχι το πώς ακριβώς
 * Οι λεπτομέρειες δεν σβήνονται· γίνονται απρόσιτες, και ξαναβρίσκονται με προσπάθεια (rehearse).
 */
export type Depth = 1 | 2 | 3;
export const DEPTH_DETAIL = 0.6;
export const DEPTH_ESSENTIALS = 0.25;

export function depthOf(strengthNow: number): Depth {
  return strengthNow >= DEPTH_DETAIL ? 3 : strengthNow >= DEPTH_ESSENTIALS ? 2 : 1;
}

/** Η εικόνα της ανάμνησης· αν δεν γράφτηκε ποτέ, οι πρώτες λέξεις των βασικών. */
export function gistOf(m: Pick<Memory, "gist" | "content">): string {
  if (m.gist) return m.gist;
  const words = m.content.split(/\s+/);
  return words.length <= 9 ? m.content : `${words.slice(0, 9).join(" ")}…`;
}

/** Πόσο ανεβαίνει η ισχύς με κάθε ανάκληση: περίπου ένα επίπεδο βάθους. */
const REHEARSAL_GAIN = 0.35;

/**
 * Η ανάκληση ως προσπάθεια: κάθε φορά που κάτι έρχεται στο μυαλό, γίνεται λίγο πιο προσιτό —
 * ένα επίπεδο τη φορά, όχι όλα μαζί. Επιστρέφει το νέο "πότε το θυμήθηκα τελευταία" που αντιστοιχεί
 * στην αυξημένη ισχύ. Έτσι, όσο η κουβέντα επιμένει σε κάτι, ξαναβρίσκει τα βασικά και μετά τις
 * λεπτομέρειες, όπως κι εμείς.
 */
export function rehearse(m: Pick<Memory, "importance" | "recallCount" | "lastRecalledAt">, now: Date): Date {
  const target = Math.min(1, strength(m, now) + REHEARSAL_GAIN);
  if (target >= 1) return now;
  // Η επόμενη ανάκληση μετρά με ένα recall παραπάνω, άρα με μεγαλύτερη σταθερότητα.
  const days = stabilityDays(m.importance, m.recallCount + 1) * Math.log2(1 / target);
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Το "πίσω μέρος του μυαλού": πέρα από όσα ανακλήθηκαν σε βάθος, οι εικόνες από μερικές ακόμη
 * σχετικές αναμνήσεις. Λίγες λέξεις η καθεμία, άρα πολλή "γεύση" γνώσης με ελάχιστο κόστος —
 * «αυτό το ξέρω», «αυτό είναι επικίνδυνο» — χωρίς να φορτώνονται οι λεπτομέρειες.
 */
export function periphery(memories: Memory[], cue: number[], focused: Recalled[], now: Date, limit = 10): string[] {
  const out: Memory[] = [];
  const ranked = memories
    .filter((m) => strength(m, now) >= FORGOTTEN_BELOW && !focused.some((f) => f.memory.id === m.id))
    .map((memory) => ({ memory, sim: cosine(cue, memory.embedding) }))
    .sort((a, b) => b.sim - a.sim);
  for (const { memory } of ranked) {
    if (out.length >= limit) break;
    const echo = [...focused.map((f) => f.memory), ...out].some(
      (kept) => cosine(kept.embedding, memory.embedding) >= SAME_MEMORY_SIMILARITY,
    );
    if (!echo) out.push(memory);
  }
  return out.map(gistOf);
}

/** Τα θέματα για τα οποία "ξέρει ότι ξέρει κάτι", με τα πιο φρέσκα πρώτα. */
export function topicIndex(memories: Memory[], now: Date, limit = 10): { topic: string; count: number; fresh: boolean }[] {
  const shelves = new Map<string, { count: number; latest: number }>();
  for (const m of memories) {
    if (!m.topic || strength(m, now) < FORGOTTEN_BELOW) continue;
    const shelf = shelves.get(m.topic) ?? { count: 0, latest: 0 };
    shelf.count++;
    shelf.latest = Math.max(shelf.latest, m.createdAt.getTime());
    shelves.set(m.topic, shelf);
  }
  return [...shelves.entries()]
    .sort((a, b) => b[1].latest - a[1].latest)
    .slice(0, limit)
    .map(([topic, shelf]) => ({ topic, count: shelf.count, fresh: now.getTime() - shelf.latest < DAY_MS }));
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
  /** Πόσο βαθιά φτάνει αυτή τη στιγμή. */
  depth: Depth;
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
      return { memory, score, similarity, strength: s, depth: depthOf(s) };
    })
    .filter((r) => r.strength >= FORGOTTEN_BELOW);

  // Δεν έρχεται στο μυαλό η ίδια σκέψη πέντε φορές με άλλα λόγια: από κάθε ομάδα σχεδόν ίδιων
  // αναμνήσεων περνά μόνο η καλύτερη, ώστε να μένει χώρος και για κάτι διαφορετικό.
  const byScore: Recalled[] = [];
  for (const candidate of [...alive].sort((a, b) => b.score - a.score)) {
    if (byScore.length >= limit) break;
    const echo = byScore.some((kept) => cosine(kept.memory.embedding, candidate.memory.embedding) >= SAME_MEMORY_SIMILARITY);
    if (!echo) byScore.push(candidate);
  }
  // Τα πολύ βασικά (π.χ. το όνομά του) είναι πάντα διαθέσιμα, άσχετα με το θέμα.
  const core = [...alive]
    .sort((a, b) => b.memory.importance * b.strength - a.memory.importance * a.strength)
    .slice(0, 2);
  for (const c of core) {
    const echo = byScore.some((kept) => cosine(kept.memory.embedding, c.memory.embedding) >= SAME_MEMORY_SIMILARITY);
    if (!byScore.includes(c) && !echo) byScore.push(c);
  }
  return byScore;
}
