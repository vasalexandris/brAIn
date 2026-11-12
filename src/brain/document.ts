/**
 * Μεγάλα κείμενα (ιστοσελίδες) που δεν χωρούν, και δεν χρειάζεται να χωρούν, στο context.
 *
 * Ολόκληρο το κείμενο μένει στη βάση. Στο μοντέλο πηγαίνει πρώτα μια περιγραφή του τι περιέχει,
 * και μετά, σε κάθε ερώτηση, μόνο τα κομμάτια που την αφορούν.
 */

/** Πάνω από τόσους χαρακτήρες, ένα κείμενο διαβάζεται ως έγγραφο: περιγραφή πρώτα, βάθος μετά. */
export const DOCUMENT_MIN_CHARS = 6000;
const CHUNK_CHARS = 1300;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Οι "ρίζες" των λέξεων ενός κειμένου: τα πρώτα πέντε γράμματα κάθε λέξης με τέσσερα και πάνω.
 * Χοντροκομμένο, αλλά αρκεί για να ταιριάξει «αξιολόγηση» με «αξιολόγησης» χωρίς κλήση σε μοντέλο.
 */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalize(text).split(/[^\p{L}\p{N}]+/u)) if (word.length >= 4) out.add(word.slice(0, 5));
  return out;
}

/** Κόβει το κείμενο σε κομμάτια στα όρια των παραγράφων. */
export function chunk(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n+/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (current && current.length + p.length + 1 > size) {
      chunks.push(current);
      current = "";
    }
    // Μια παράγραφος μεγαλύτερη από ένα κομμάτι σπάει σε σταθερά μήκη.
    for (let i = 0; i < p.length; i += size) {
      const piece = p.slice(i, i + size);
      if (current && current.length + piece.length + 1 > size) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Τα κομμάτια του κειμένου που αφορούν την ερώτηση, με τη σειρά που εμφανίζονται στο κείμενο.
 * Κενό αν τίποτα δεν ταιριάζει: τότε η ερώτηση δεν αφορά αυτό το έγγραφο.
 */
export function excerpts(text: string, question: string, limit = 3): string[] {
  const wanted = stems(question);
  if (!wanted.size) return [];
  const pieces = chunk(text).map((piece, index) => ({ piece, index, have: stems(piece) }));
  // Μια λέξη που υπάρχει σχεδόν σε κάθε κομμάτι (το θέμα της σελίδας) δεν ξεχωρίζει κανένα· μια
  // σπάνια δείχνει ακριβώς πού βρίσκεται η απάντηση. Κάθε λέξη μετρά όσο σπάνια είναι.
  const weight = new Map<string, number>();
  for (const s of wanted) {
    const found = pieces.filter((p) => p.have.has(s)).length;
    if (found) weight.set(s, Math.log(1 + pieces.length / found));
  }
  return pieces
    .map((p) => {
      let score = 0;
      for (const [s, w] of weight) if (p.have.has(s)) score += w;
      // Λίστες συνδέσμων και μενού περιέχουν κάθε λέξη-κλειδί χωρίς να λένε τίποτα: σύντομες γραμμές,
      // χωρίς προτάσεις. Μετρούν πολύ λιγότερο από κανονικό κείμενο.
      const lines = p.piece.split("\n");
      const listy = p.piece.length / lines.length < 45;
      return { ...p, score: listy ? score * 0.25 : score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.piece);
}
