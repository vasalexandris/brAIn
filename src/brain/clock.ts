/**
 * Το ρολόι του εγκεφάλου: ώρες και διάρκειες σε μορφή που λέει κανείς φωναχτά.
 * Όλες οι ώρες είναι ώρες Ελλάδας, όπου ζει ο συνομιλητής.
 */

const TZ = "Europe/Athens";

/** Η μέρα στην Ελλάδα ως ΕΕΕΕ-ΜΜ-ΗΗ. */
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

const hour = (d: Date) => Number(d.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false })) % 24;

/** Η ώρα ως ΩΩ:ΛΛ. */
export function clock(d: Date): string {
  return d.toLocaleTimeString("el-GR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Μέρος της ημέρας. */
export function dayPart(d: Date): "πρωί" | "μεσημέρι" | "απόγευμα" | "βράδυ" | "νύχτα" {
  const h = hour(d);
  if (h >= 5 && h < 12) return "πρωί";
  if (h >= 12 && h < 15) return "μεσημέρι";
  if (h >= 15 && h < 20) return "απόγευμα";
  if (h >= 20) return "βράδυ";
  return "νύχτα";
}

/** Πόσες ημερολογιακές μέρες πριν ήταν το `d`, σε σχέση με το `now`. */
export function calendarDaysAgo(d: Date, now: Date): number {
  const [y1, m1, d1] = dayKey(d).split("-").map(Number);
  const [y2, m2, d2] = dayKey(now).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const WITH_ARTICLE = { πρωί: "το πρωί", μεσημέρι: "το μεσημέρι", απόγευμα: "το απόγευμα", βράδυ: "το βράδυ", νύχτα: "τη νύχτα" } as const;

/** «σήμερα το πρωί (08:08)», «χθες το βράδυ (21:04)», «Παρασκευή 13/11 το απόγευμα (17:30)». */
export function when(d: Date, now: Date): string {
  const part = WITH_ARTICLE[dayPart(d)];
  const time = `(${clock(d)})`;
  const days = calendarDaysAgo(d, now);
  if (days <= 0) return `σήμερα ${part} ${time}`;
  if (days === 1) return `χθες ${part} ${time}`;
  const date = d.toLocaleDateString("el-GR", { timeZone: TZ, weekday: "long", day: "numeric", month: "numeric" });
  return `${date} ${part} ${time}`;
}

/** Διάρκεια σε λόγια, με «περίπου» όταν είναι ώρες ή μέρες — όπως θα το έλεγε κανείς. */
export function approxSpan(min: number): string {
  if (min < 1) return "λίγα δευτερόλεπτα";
  if (min < 2) return "ένα λεπτό";
  if (min < 60) return `${Math.round(min)} λεπτά`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? "περίπου μία ώρα" : `περίπου ${hours} ώρες`;
  const days = Math.round(min / (60 * 24));
  return days === 1 ? "περίπου μία μέρα" : `περίπου ${days} μέρες`;
}

export interface Session {
  start: Date;
  end: Date;
}

/**
 * Χωρίζει μια σειρά χρονικών σημείων σε κουβέντες: όταν περάσουν πάνω από `gapMin` λεπτά χωρίς
 * μήνυμα, αρχίζει καινούρια. Επιστρέφει πρώτη την πιο πρόσφατη.
 */
export function sessionsFrom(timestamps: Date[], gapMin: number): Session[] {
  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const out: Session[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && (t.getTime() - last.end.getTime()) / 60000 <= gapMin) last.end = t;
    else out.push({ start: t, end: t });
  }
  return out.reverse();
}
