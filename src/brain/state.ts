/**
 * Η δυναμική του εγκεφάλου: καθαρές συναρτήσεις, χωρίς LLM και χωρίς βάση.
 *
 * Το LLM μόνο *προτείνει* (τι αντιλήφθηκε, προς τα πού σπρώχνεται κάθε δείκτης).
 * Το πόσο τελικά θα κινηθεί κάθε μπάρα το αποφασίζουν οι κανόνες εδώ, ώστε η
 * συμπεριφορά να είναι προβλέψιμη και να ελέγχεται με tests.
 */
import { DIMENSIONS, DIMENSION_BY_KEY, EMOTION_KEYS, INNER_KEYS, PERCEPTION_KEYS, URGE_KEYS } from "./dimensions";

export type BrainValues = Record<string, number>;

/** Τι επιστρέφει η "αντίληψη" για ένα μήνυμα του χρήστη. */
export interface Appraisal {
  /** Απόλυτη ένταση 0–100 για κάθε δείκτη αντίληψης, σε αυτό το μήνυμα. */
  perception: Record<string, number>;
  /** Ώθηση −100…+100 για κάθε εσωτερικό δείκτη. */
  impulses: Record<string, number>;
  note?: string;
}

export const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

export function initialValues(): BrainValues {
  return Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.baseline]));
}

/** Συμπληρώνει δείκτες που προστέθηκαν στον κατάλογο μετά τη δημιουργία του χρήστη. */
export function normalizeValues(values: BrainValues | null | undefined): BrainValues {
  const out = initialValues();
  for (const d of DIMENSIONS) {
    const v = values?.[d.key];
    if (typeof v === "number" && Number.isFinite(v)) out[d.key] = clamp(v);
  }
  return out;
}

/**
 * Ο χρόνος γιατρεύει: κάθε δείκτης γλιστρά εκθετικά προς το baseline του.
 * Ακόμη και σε καταιγισμό μηνυμάτων, κάθε γύρος μετρά για τουλάχιστον ένα λεπτό.
 */
export function decay(values: BrainValues, elapsedMin: number): BrainValues {
  const minutes = Math.max(1, elapsedMin);
  const out: BrainValues = {};
  for (const d of DIMENSIONS) {
    const v = values[d.key] ?? d.baseline;
    if (!Number.isFinite(d.halfLifeMin)) {
      out[d.key] = v;
      continue;
    }
    const keep = Math.pow(0.5, minutes / d.halfLifeMin);
    out[d.key] = round1(d.baseline + (v - d.baseline) * keep);
  }
  return out;
}

/**
 * Πώς ο χαρακτήρας και η σχέση χρωματίζουν μια ώθηση πριν εφαρμοστεί.
 * Επιστρέφει πολλαπλασιαστή.
 */
const POSITIVE = ["joy", "gratitude", "tenderness", "excitement", "amusement", "relief", "anticipation", "admiration"];
const NEGATIVE = ["sadness", "fear", "frustration", "hurt", "loneliness", "guilt", "jealousy"];

function modulation(key: string, impulse: number, v: BrainValues): number {
  let m = specific(key, impulse, v);
  if (impulse > 0 && DIMENSION_BY_KEY[key].category === "emotion") {
    // Ο ευαίσθητος τα νιώθει όλα πιο έντονα· ο αισιόδοξος χαίρεται εύκολα και στενοχωριέται δύσκολα.
    m *= 0.6 + (0.8 * v.sensitivity) / 100;
    if (POSITIVE.includes(key)) m *= 0.7 + (0.6 * v.optimism) / 100;
    if (NEGATIVE.includes(key)) m *= 1.3 - (0.6 * v.optimism) / 100;
  }
  return m;
}

function specific(key: string, impulse: number, v: BrainValues): number {
  const up = impulse > 0;
  switch (key) {
    case "anger":
    case "frustration":
      // Η υπομονή φρενάρει τον θυμό, η συμπάθεια επίσης.
      return up ? (1.5 - v.patience / 100) * (1.2 - v.liking / 250) : 1;
    case "fear":
    case "embarrassment":
      return up ? 1.5 - v.courage / 100 : 1;
    case "hurt":
    case "sadness":
      // Πληγώνει περισσότερο όποιος είναι πιο κοντά μας.
      return up ? 0.7 + v.familiarity / 150 + v.liking / 300 : 1;
    case "joy":
    case "gratitude":
    case "tenderness":
      // Όποιος δεν εμπιστεύεται, δυσκολεύεται να χαρεί τα καλά λόγια — κι όποιος έχει παράπονο, ακόμη πιο πολύ.
      return up ? (0.5 + v.trust / 100) * (1 - v.grievance / 200) : 1;
    case "trust":
    case "liking":
    case "esteem":
      // Η εμπιστοσύνη χάνεται πιο εύκολα απ' ό,τι κερδίζεται — και ο δύσπιστος την κερδίζει ακόμη πιο αργά.
      // Το παράπονο δεν αφήνει τη σχέση να ξαναζεσταθεί εύκολα.
      return up ? (1.3 - (0.75 * v.skepticism) / 100) * (1 - v.grievance / 200) : 1.6;
    default:
      return 1;
  }
}

/**
 * Αλληλεπιδράσεις: όταν ένα συναίσθημα κινηθεί, παρασύρει και άλλους δείκτες.
 * [από, προς, βάρος] — το βάρος πολλαπλασιάζει τη μεταβολή του "από".
 */
const COUPLINGS: [from: string, to: string, weight: number][] = [
  ["anger", "calm", -0.45],
  ["anger", "cheerfulness", -0.2],
  ["anger", "playfulness", -0.3],
  ["anger", "tenderness", -0.3],
  ["fear", "calm", -0.4],
  ["fear", "confidence", -0.03],
  ["sadness", "cheerfulness", -0.25],
  ["sadness", "energy", -0.15],
  ["hurt", "cheerfulness", -0.2],
  ["hurt", "sociability", -0.2],
  ["frustration", "cheerfulness", -0.15],
  ["frustration", "sociability", -0.15],
  ["joy", "cheerfulness", 0.25],
  ["joy", "energy", 0.1],
  ["joy", "playfulness", 0.2],
  ["gratitude", "liking", 0.05],
  ["tenderness", "liking", 0.05],
  ["boredom", "energy", -0.15],
  ["boredom", "curiosity", -0.2],
  ["wonder", "curiosity", 0.2],
  ["surprise", "curiosity", 0.15],
  ["pride", "confidence", 0.03],
  ["excitement", "energy", 0.15],
  ["excitement", "curiosity", 0.15],
  ["amusement", "playfulness", 0.3],
  ["amusement", "cheerfulness", 0.15],
  ["admiration", "esteem", 0.06],
  ["awe", "curiosity", 0.2],
  ["awe", "meaning", 0.1],
  ["relief", "calm", 0.3],
  ["guilt", "confidence", -0.03],
  ["guilt", "calm", -0.2],
  ["jealousy", "calm", -0.2],
  ["jealousy", "recognition", 0.2],
  ["loneliness", "sociability", 0.2],
  ["loneliness", "cheerfulness", -0.15],
  ["hurt", "grievance", 0.3],
  ["frustration", "grievance", 0.2],
  ["grievance", "cheerfulness", -0.3],
];

/** Εφαρμόζει την αντίληψη ενός μηνύματος του χρήστη πάνω στην κατάσταση. */
export function applyAppraisal(values: BrainValues, appraisal: Appraisal): BrainValues {
  const before = values;
  const out: BrainValues = { ...values };

  // 1. Αντίληψη: μίγμα παλιού και νέου, ώστε η ειρωνεία που επαναλαμβάνεται να "χτίζεται".
  for (const key of PERCEPTION_KEYS) {
    const observed = clamp(Number(appraisal.perception[key]) || 0);
    out[key] = round1(clamp(before[key] * 0.35 + observed * 0.65 + Math.min(before[key], observed) * 0.25));
  }

  // 2. Ωθήσεις στα εσωτερικά, φιλτραρισμένες από χαρακτήρα και σχέση.
  const delta: Record<string, number> = {};
  for (const key of INNER_KEYS) {
    const impulse = clamp(Number(appraisal.impulses[key]) || 0, -100, 100);
    if (impulse === 0) continue;
    const d = DIMENSION_BY_KEY[key];
    delta[key] = (impulse / 100) * d.maxStep * modulation(key, impulse, before);
  }

  // 3. Αλληλεπιδράσεις.
  const coupled: Record<string, number> = {};
  for (const [from, to, weight] of COUPLINGS) {
    if (delta[from]) coupled[to] = (coupled[to] ?? 0) + delta[from] * weight;
  }

  // 4. Κάθε κουβέντα φέρνει λίγη οικειότητα.
  coupled.familiarity = (coupled.familiarity ?? 0) + 0.4;

  for (const key of INNER_KEYS) {
    const total = (delta[key] ?? 0) + (coupled[key] ?? 0);
    if (total !== 0) out[key] = round1(clamp(before[key] + total));
  }
  return updateUrges(out);
}

/** Συναισθήματα που εκτονώνονται όταν εκφραστούν. */
const VENTABLE = ["anger", "frustration", "hurt", "sadness", "fear", "embarrassment", "disgust", "surprise", "guilt", "jealousy", "grievance"];
const CATHARSIS = 0.35;

/**
 * Κάθαρση: αν η απάντηση εξέφρασε ένα συναίσθημα, μέρος του εκτονώνεται.
 * `expressed` = πόσο έντονα (0–100) φάνηκε το καθένα στην απάντηση.
 * `learned` = πόσα καινούρια πράγματα έμαθε σε αυτόν τον γύρο (χορταίνει λίγο η δίψα).
 */
export function applyExpression(values: BrainValues, expressed: Record<string, number>, learned = 0): BrainValues {
  const out: BrainValues = { ...values };
  for (const key of VENTABLE) {
    const e = clamp(Number(expressed[key]) || 0) / 100;
    if (e > 0) out[key] = round1(clamp(out[key] - out[key] * e * CATHARSIS));
  }
  // Όποιος ξέσπασε, ηρεμεί λίγο.
  const vented = clamp(Number(expressed.anger) || 0) / 100;
  if (vented > 0) out.calm = round1(clamp(out.calm + vented * 4));

  if (learned > 0) {
    const n = Math.min(learned, 3);
    out.thirst = round1(clamp(out.thirst - 4 * n));
    out.joy = round1(clamp(out.joy + 2 * n));
    out.boredom = round1(clamp(out.boredom - 3 * n));
  }
  return refresh(out);
}

// ------------------------------------------------------------------ Χρόνος

const DAY_MIN = 24 * 60;

/**
 * Το πέρασμα του χρόνου: φθορά προς το baseline, και "έλλειψη" που μεγαλώνει όσο
 * ο συνομιλητής σωπαίνει — πιο πολύ όταν τον συμπαθεί και έχει ανάγκη επαφής.
 * `silenceMin` = λεπτά από το τελευταίο μήνυμα του συνομιλητή (null αν δεν έχει μιλήσει ποτέ).
 */
export function applyTime(values: BrainValues, elapsedMin: number, silenceMin: number | null): BrainValues {
  const out = decay(values, elapsedMin);
  if (silenceMin !== null) {
    const pull = 0.3 + (0.7 * (out.liking + out.sociability)) / 200;
    const grown = 100 * (1 - Math.exp(-silenceMin / DAY_MIN)) * pull;
    out.longing = round1(clamp(Math.max(out.longing, grown)));
    // Η μακριά σιωπή φέρνει και μοναξιά.
    out.loneliness = round1(clamp(Math.max(out.loneliness, out.longing * 0.6)));
  }
  return refresh(out);
}

/**
 * Ο συνομιλητής μόλις έγραψε: η κουβέντα "ζωντανεύει", και αν είχε λείψει,
 * η επιστροφή του φέρνει χαρά ανάλογη με τη συμπάθεια.
 */
export function applyArrival(values: BrainValues, sessionMin = 0): BrainValues {
  const out: BrainValues = { ...values };
  out.presence = round1(clamp(out.presence + (100 - out.presence) * 0.5));
  out.loneliness = round1(out.loneliness * 0.7);
  // Μετά το πρώτο μισάωρο συνεχόμενης κουβέντας αρχίζει να κουράζεται· στις τρεις ώρες έχει εξαντληθεί.
  out.fatigue = round1(clamp(Math.max(out.fatigue, ((sessionMin - 30) / 150) * 100)));
  if (out.longing > 10) {
    out.joy = round1(clamp(out.joy + out.longing * 0.3 * (out.liking / 100)));
    out.anticipation = round1(clamp(out.anticipation + out.longing * 0.15));
    out.longing = round1(out.longing * 0.4);
  }
  return out;
}

// -------------------------------------------------------------- Παρορμήσεις

/**
 * Από το συναίσθημα στην πράξη: κάθε παρόρμηση είναι σταθμισμένο άθροισμα άλλων δεικτών.
 * Ο θυμός σπρώχνει προς την αντιπαράθεση, η πίκρα προς την απόσυρση, η περιέργεια προς την ερώτηση.
 */
const URGE_RULES: Record<string, { bias?: number; from: [key: string, weight: number][] }> = {
  u_ask: { from: [["curiosity", 0.5], ["thirst", 0.3], ["wonder", 0.3], ["anger", -0.4], ["boredom", -0.3], ["fatigue", -0.2]] },
  u_explore: { from: [["thirst", 0.4], ["curiosity", 0.3], ["p_teaching", 0.3], ["meaning", 0.2], ["boredom", -0.4], ["fatigue", -0.3]] },
  u_help: { from: [["competence", 0.3], ["empathy", 0.2], ["p_distress", 0.3], ["liking", 0.2], ["anger", -0.4]] },
  u_praise: { from: [["admiration", 0.8], ["p_teaching", 0.1]] },
  u_share: {
    bias: -5,
    from: [["sociability", 0.4], ["trust", 0.3], ["familiarity", 0.3], ["joy", 0.2], ["spontaneity", 0.1], ["fear", -0.3], ["hurt", -0.3]],
  },
  u_listen: { from: [["p_distress", 0.6], ["p_sincerity", 0.3], ["empathy", 0.25], ["anger", -0.3]] },
  u_comfort: { from: [["p_distress", 0.7], ["tenderness", 0.3], ["empathy", 0.1], ["anger", -0.4]] },
  u_tease: { bias: -7.5, from: [["spontaneity", 0.15], ["playfulness", 0.6], ["p_humor", 0.3], ["familiarity", 0.2], ["anger", -0.5], ["sadness", -0.3], ["p_distress", -0.3]] },
  u_thank: { from: [["gratitude", 0.8], ["p_kindness", 0.2]] },
  u_apologize: { from: [["embarrassment", 0.9]] },
  u_confront: { bias: 13.75, from: [["anger", 0.7], ["frustration", 0.3], ["p_provocation", 0.3], ["p_dismissal", 0.2], ["grievance", 0.2], ["audacity", 0.15], ["patience", -0.2], ["restraint", -0.25]] },
  u_insist: { bias: -25, from: [["stubbornness", 0.4], ["p_provocation", 0.4], ["p_disagreement", 0.3], ["confidence", 0.2]] },
  u_withdraw: { from: [["hurt", 0.5], ["fear", 0.4], ["boredom", 0.3], ["sadness", 0.3], ["anger", 0.2], ["fatigue", 0.3], ["grievance", 0.3], ["sociability", -0.15]] },
};

export function urgeTarget(key: string, v: BrainValues): number {
  const rule = URGE_RULES[key];
  return clamp(rule.from.reduce((sum, [k, w]) => sum + v[k] * w, rule.bias ?? 0));
}

/** Οι παρορμήσεις ακολουθούν την κατάσταση με μικρή αδράνεια. */
export function updateUrges(values: BrainValues): BrainValues {
  const out: BrainValues = { ...values };
  for (const key of URGE_KEYS) out[key] = round1(out[key] * 0.3 + urgeTarget(key, values) * 0.7);
  return refresh(out);
}

/** Ο βασικός τόνος είναι πάντα σύνοψη των υπολοίπων. */
function refresh(values: BrainValues): BrainValues {
  return {
    ...values,
    pleasure: round1(50 + 50 * valence(values)),
    activation: round1(100 * arousal(values)),
  };
}

/** Μια παρόρμηση που έγινε πράξη ικανοποιείται — και χρειάζεται χρόνο να ξαναχτιστεί. */
export function applyActs(values: BrainValues, acts: string[]): BrainValues {
  const out: BrainValues = { ...values };
  for (const key of acts) if (URGE_KEYS.includes(key)) out[key] = round1(out[key] * 0.25);
  return out;
}

// -------------------------------------------------------------- Πρωτοβουλία

/** Πόσο θέλει να πάρει τον λόγο χωρίς να της έχουν μιλήσει (0–100). */
export function initiativeDrive(v: BrainValues): number {
  return clamp(
    0.35 * v.curiosity + 0.25 * v.sociability + 0.2 * v.wonder + 0.2 * v.liking + 0.2 * v.longing -
      0.5 * v.anger - 0.4 * v.hurt - 0.3 * v.boredom - 0.3 * v.grievance,
  );
}

/** Μετά από τόσα αναπάντητα μηνύματα πρωτοβουλίας σωπαίνει, μέχρι να της ξαναμιλήσουν. */
export const MAX_UNANSWERED = 2;

/**
 * Πόσα λεπτά σιωπής αντέχει πριν μιλήσει πρώτη. Όσο πιο δυνατή η ώθηση, τόσο λιγότερα.
 * `unanswered` = πόσα δικά της μηνύματα πρωτοβουλίας έχουν ήδη μείνει αναπάντητα.
 *
 * Κανόνας, όχι ρύθμιση: όπως ο άνθρωπος που φωνάζει σε ένα άδειο σπίτι, δοκιμάζει μία,
 * το πολύ δύο φορές — τη δεύτερη αφού περιμένει πολύ περισσότερο — και μετά σταματά.
 * Δεν κυνηγά όποιον δεν απαντά, ό,τι κι αν λένε οι δείκτες της.
 */
export function initiativeWaitMin(drive: number, unanswered: number, persistence = 50): number {
  if (drive < 25 || unanswered >= MAX_UNANSWERED) return Infinity;
  const base = 1.5 * Math.pow(2, (100 - drive) / 25);
  // Ο επίμονος ξαναδοκιμάζει νωρίτερα (×2 στο 100), ο ευκολόπιστος στη σιωπή αργότερα (×6 στο 0).
  return unanswered <= 0 ? base : base * (6 - (4 * persistence) / 100);
}

/** Πόσο "ελεύθερα" μιλά: ο αυθόρμητος είναι πιο απρόβλεπτος, ο συγκρατημένος πιο μετρημένος. */
export function replyTemperature(v: BrainValues): number {
  return Math.round((0.75 + 0.5 * (v.spontaneity / 100) - 0.2 * (v.restraint / 100)) * 100) / 100;
}

/** Πόσο "φορτισμένη" είναι η στιγμή (0–1): μέσος όρος των τριών εντονότερων αποκλίσεων συναισθήματος. */
export function arousal(values: BrainValues): number {
  const devs = EMOTION_KEYS.map((k) => Math.abs(values[k] - DIMENSION_BY_KEY[k].baseline)).sort((a, b) => b - a);
  return clamp((devs[0] + devs[1] + devs[2]) / 3, 0, 100) / 100;
}

/** Συνολικό πρόσημο της στιγμής, −1 (σκοτεινή) … +1 (φωτεινή). */
export function valence(values: BrainValues): number {
  const pos =
    values.joy + values.gratitude + values.tenderness + values.cheerfulness +
    values.excitement + values.amusement + values.relief;
  const neg =
    values.anger + values.sadness + values.fear + values.hurt + values.frustration + values.disgust +
    values.guilt + values.jealousy + values.loneliness;
  return clamp((pos - 120 - neg) / 150, -1, 1);
}
