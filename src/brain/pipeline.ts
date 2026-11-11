/**
 * Ένας γύρος συζήτησης, από άκρη σε άκρη:
 *
 *   μήνυμα → [χρόνος] → ΑΝΤΙΛΗΨΗ → [δυναμική] → ΑΝΑΚΛΗΣΗ → ΑΠΟΚΡΙΣΗ → ΑΝΑΣΤΟΧΑΣΜΟΣ → [κάθαρση, μνήμη]
 *
 * Τα κεφαλαία είναι κλήσεις σε μοντέλο· τα [αγκυλωμένα] είναι κανόνες στον κώδικα.
 */
import type { Db } from "@/db";
import * as repo from "@/db/repo";
import type { LlmProvider } from "@/llm/types";
import { INNER_KEYS, PERCEPTION_KEYS, URGE_KEYS } from "./dimensions";
import {
  FORGOTTEN_BELOW,
  MIN_IMPORTANCE,
  SAME_MEMORY_SIMILARITY,
  cosine,
  encodeImportance,
  gistOf,
  recall,
  rehearse,
  strength,
  topicIndex,
  type Memory,
  type MemoryKind,
} from "./memory";
import { HEADLINES_QUERY, SOURCES, SOURCE_LABELS, lookup as defaultLookup, type Lookup, type Source } from "./world";
import {
  PERCEIVE_SYSTEM,
  PLAN_SYSTEM,
  REFLECT_SYSTEM,
  planPrompt,
  initiativeBlock,
  materialPrompt,
  readingBlock,
  perceivePrompt,
  reflectPrompt,
  respondSystem,
  SELF_IMAGE_MAX,
  silenceTurn,
  trimToSentence,
  type TimeSense,
} from "./prompts";
import {
  applyActs,
  applyAppraisal,
  applyArrival,
  applyExpression,
  applyProgress,
  applyTime,
  arousal,
  clamp,
  initiativeDrive,
  initiativeWaitMin,
  replyTemperature,
  valence,
  type Appraisal,
  type BrainValues,
} from "./state";

/**
 * Όρια κόστους ανά χρήστη και εικοσιτετράωρο. Κάθε μήνυμα σημαίνει κλήσεις σε μοντέλο που
 * χρεώνονται· τα όρια αυτά ισχύουν ό,τι κι αν λένε οι δείκτες.
 */
export const DAILY_MESSAGE_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT) || 200;
const DAILY_INITIATIVE_LIMIT = 6;
export const DAILY_SEARCH_LIMIT = 20;
/** Μετά από μια πρόταση αναζήτησης (όπως κι αν κατέληξε) δεν ξαναπροτείνει για τόσα λεπτά. */
const SEARCH_COOLDOWN_MIN = 10;
/** Κάτω από τόση όρεξη «να εμβαθύνω» δεν ζητά να ψάξει. */
const SEARCH_MIN_URGE = 40;
/** Για τόσα λεπτά μετά από μια αναζήτηση, το υλικό της μένει μπροστά της. */
const MATERIAL_KEEP_MIN = 45;
const dayAgo = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);

export class DailyLimitError extends Error {}

/** Πόσα πρόσφατα μηνύματα μένουν στην "άμεση" μνήμη εργασίας. */
const WORKING_MEMORY = 16;
const MEMORY_KINDS: MemoryKind[] = ["user_fact", "episode", "knowledge", "opinion", "self", "goal", "lesson"];
/** Πόσους στόχους έχει "στο μυαλό" της ταυτόχρονα. */
const ACTIVE_GOALS = 3;
/** Πόσα μαθήματα για τον εαυτό της έχει πάντα μπροστά της. */
const ACTIVE_LESSONS = 4;
/** Πάνω από τόση εμμονή δεν ζητά να ψάξει: έχει ήδη κολλήσει. */
const SEARCH_MAX_FIXATION = 50;

/** Με ποιες υπάρχουσες αναμνήσεις συνδέεται μια νέα: οι δύο πιο συγγενικές, χωρίς να είναι η ίδια. */
function linksFor(embedding: number[], memories: Memory[]): string[] {
  return memories
    .map((m) => ({ id: m.id, sim: cosine(m.embedding, embedding) }))
    .filter((x) => x.sim >= 0.6 && x.sim < SAME_MEMORY_SIMILARITY)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 2)
    .map((x) => x.id);
}

/** Ό,τι χρειάζεται το prompt για να δείξει τη μνήμη σε βάθος: εικόνες των συνδεδεμένων και τα "ράφια". */
function memoryMap(memories: Memory[], now: Date) {
  return {
    gists: Object.fromEntries(memories.map((m) => [m.id, gistOf(m)])),
    topics: topicIndex(memories, now),
  };
}

/** Τα ισχυρότερα ζωντανά ενός είδους. */
function strongest(memories: Memory[], kind: MemoryKind, now: Date, limit: number): Memory[] {
  return memories
    .filter((m) => m.kind === kind && strength(m, now) >= FORGOTTEN_BELOW)
    .sort((x, y) => y.importance * strength(y, now) - x.importance * strength(x, now))
    .slice(0, limit);
}

/**
 * Χωρίζει τη μνήμη σε ό,τι έχει πάντα μπροστά της — ενεργούς στόχους και μαθήματα για τον εαυτό
 * της — και σε όλα τα υπόλοιπα, που ανακαλούνται μόνο όταν κάτι τα θυμίσει.
 */
function splitGoals(memories: Memory[], now: Date) {
  return {
    goals: strongest(memories, "goal", now, ACTIVE_GOALS),
    lessons: strongest(memories, "lesson", now, ACTIVE_LESSONS).map((m) => m.content),
    rest: memories.filter((m) => m.kind !== "goal" && m.kind !== "lesson"),
  };
}

export interface SearchProposal {
  id: string;
  source: Source;
  sourceLabel: string;
  query: string;
}

export const toProposal = (s: repo.Search): SearchProposal => ({
  id: s.id,
  source: s.source,
  sourceLabel: SOURCE_LABELS[s.source],
  query: s.query,
});

export interface TurnResult {
  reply: string;
  /** Δεύτερο μήνυμα στον ίδιο γύρο: όσα βρήκε, όταν ο συνομιλητής τής είπε ρητά να ψάξει. */
  extra: string | null;
  values: BrainValues;
  /** Αν θέλει να ψάξει κάτι: περιμένει την έγκριση του συνομιλητή. */
  search: SearchProposal | null;
  debug: {
    note: string;
    recalled: string[];
    stored: string[];
    impression: string;
    selfImage: string;
    goals: string[];
    lessons: string[];
    /** Τα ράφια της μνήμης: για ποια θέματα ξέρει ότι ξέρει κάτι. */
    topics?: string[];
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function numbers(x: unknown, allowed: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(x)) return out;
  for (const key of allowed) {
    const n = Number(x[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/** Το μοντέλο μπορεί να επιστρέψει οτιδήποτε· κρατάμε μόνο ό,τι έχει το σωστό σχήμα. */
function parseAppraisal(raw: unknown): Appraisal {
  const r = isRecord(raw) ? raw : {};
  return {
    perception: numbers(r.perception, PERCEPTION_KEYS),
    impulses: numbers(r.impulses, INNER_KEYS),
    note: typeof r.note === "string" ? r.note : "",
  };
}

interface Reflection {
  expressed: Record<string, number>;
  acts: string[];
  memories: {
    kind: MemoryKind;
    content: string;
    gist: string;
    detail: string;
    topic: string;
    importance: number;
    valence: number;
  }[];
  resolvedGoals: number[];
  impression: string;
  selfImage: string;
  search: (SearchRequest & { committed: boolean }) | null;
}

type SearchRequest = { source: Source; query: string };

const MARKER = /\[\s*ΨΑΞΕ\s+(ειδήσεις|wikipedia|web|διαδίκτυο)\s*(?::\s*([^\]]*))?\]/giu;

/**
 * Η απάντηση μπορεί να κλείνει με μια γραμμή-αίτημα, π.χ. «[ΨΑΞΕ wikipedia: κβάζαρ]».
 * Έτσι αυτό που λέει («θα ήθελα να το ψάξω») και η κάρτα που βλέπει ο συνομιλητής προέρχονται
 * από την ίδια απόφαση. Η γραμμή αφαιρείται από το κείμενο που εμφανίζεται.
 */
export function extractSearchMarker(reply: string): { text: string; request: SearchRequest | null } {
  let request: SearchRequest | null = null;
  const text = reply
    .replace(MARKER, (_, kind: string, topic: string | undefined) => {
      const query = (topic ?? "").trim().slice(0, 120);
      if (!request) {
        const k = kind.toLowerCase();
        if (k === "wikipedia") {
          if (query) request = { source: "wikipedia", query };
        } else if (k === "ειδήσεις") {
          request = query ? { source: "web", query } : { source: "headlines", query: HEADLINES_QUERY };
        } else if (query) {
          request = { source: "web", query };
        }
      }
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text, request };
}

const plain = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Ο συνομιλητής ρωτά για την επικαιρότητα· δεν χρειάζεται μοντέλο για να το καταλάβουμε. */
const NEWS_INTENT = /ειδησ|επικαιροτητ|τι (εγινε|γινεται|συμβαινει|συνεβη|παιζει).{0,40}(κοσμο|σημερα|χωρα|ελλαδα)/;
/** Ο συνομιλητής ζητά ρητά αναζήτηση. */
const SEARCH_INTENT = /ψαξ|ψαχν|αναζητ|βρες (μου|το|τα|τις|τους)|wikipedia|βικιπαιδ|γκουγκλ|google/;
/** …ή ζητά ρητά να ΜΗΝ ψάξει. */
const NO_SEARCH = /(μην?|δεν θελω να|οχι να|σταματα να) .{0,12}(ψαξ|ψαχν)/;
/** Η ίδια λέει ότι ψάχνει ή ότι θέλει να ψάξει. */
const SAYS_SEARCHING = /ψαξω|ψαχνω|αναζητησω/;

const AFTER = "(?![a-zα-ω])";
/** Ο συνομιλητής λέει «ναι» σε πρόταση αναζήτησης που εκκρεμεί. */
const AFFIRM = new RegExp(`^(ναι|οκ|ok|yes|ενταξει|βεβαια|φυσικα|αμε|εννοειται|καν.?το|γιατι οχι)${AFTER}|ψαξ|προχωρα|την εχεις|εχεις την αδεια`);
/** …ή «όχι». */
const DECLINE = new RegExp(`^(οχι|μη|ασε|ασ.?το|δεν θελω|αργοτερα)${AFTER}`);

/** Ζεύγη διψήφιων ή τριψήφιων αριθμών με παύλα, σαν σκορ («122-116»). Όχι ώρες ή μονοψήφια. */
const SCORE = /(?<!\d)\d{2,3}\s*[-–—]\s*\d{2,3}(?!\d)/g;

/**
 * Δίχτυ ασφαλείας απέναντι στην επινόηση: κάθε «σκορ» στην απάντηση πρέπει να υπάρχει και στο
 * υλικό που διάβασε. Αν όχι, το μοντέλο το έβγαλε από το μυαλό του.
 */
export function inventedScores(message: string, material: string): string[] {
  const squash = (t: string) => t.replace(/\s+/g, "").replace(/[–—]/g, "-");
  const source = squash(material);
  return (message.match(SCORE) ?? []).filter((score) => {
    // Μόνο ό,τι μοιάζει με σκορ μπάσκετ: «10-15 λεπτά» ή «20-30 χρόνια» είναι απλή κουβέντα.
    const [a, b] = squash(score).split("-").map(Number);
    return a >= 60 && b >= 60 && !source.includes(squash(score));
  });
}

/** Πόσες ερωτήσεις έχει ένα κείμενο (ελληνικό ή λατινικό ερωτηματικό). */
export function countQuestions(text: string): number {
  return (text.match(/[;\u037e?]/g) ?? []).length;
}

function parseReflection(raw: unknown): Reflection {
  const r = isRecord(raw) ? raw : {};
  const memories = (Array.isArray(r.memories) ? r.memories : [])
    .filter(isRecord)
    .map((m) => ({
      kind: MEMORY_KINDS.includes(m.kind as MemoryKind) ? (m.kind as MemoryKind) : ("episode" as MemoryKind),
      content: typeof m.content === "string" ? m.content.trim().slice(0, 500) : "",
      gist: typeof m.gist === "string" ? m.gist.trim().slice(0, 140) : "",
      detail: typeof m.detail === "string" ? m.detail.trim().slice(0, 1800) : "",
      topic: typeof m.topic === "string" ? m.topic.trim().toLowerCase().slice(0, 40) : "",
      importance: clamp(Number(m.importance) || 0),
      valence: clamp(Number(m.valence) || 0, -100, 100) / 100,
    }))
    .filter((m) => m.content)
    .slice(0, 4);
  return {
    expressed: numbers(r.expressed, INNER_KEYS),
    acts: (Array.isArray(r.acts) ? r.acts : []).filter((a): a is string => URGE_KEYS.includes(a as string)),
    memories,
    resolvedGoals: (Array.isArray(r.resolved_goals) ? r.resolved_goals : []).map(Number).filter(Number.isInteger),
    impression: typeof r.impression === "string" ? r.impression.trim().slice(0, 600) : "",
    selfImage: typeof r.self_image === "string" ? trimToSentence(r.self_image, SELF_IMAGE_MAX + 50) : "",
    search:
      isRecord(r.search) && typeof r.search.query === "string" && r.search.query.trim()
        ? {
            source: SOURCES.includes(r.search.source as Source) ? (r.search.source as Source) : "wikipedia",
            query: r.search.query.trim().slice(0, 120),
            committed: r.search.committed === true,
          }
        : null,
  };
}

const minutesBetween = (from: Date, to: Date) => Math.max(0, to.getTime() - from.getTime()) / 60000;

/** Μια παύση πάνω από τόσα λεπτά χωρίζει δύο "κουβέντες". */
const SESSION_GAP_MIN = 30;

/** Η αίσθηση του χρόνου, από τις ώρες των αποθηκευμένων μηνυμάτων. */
function senseTime(stored: repo.StoredMessage[], now: Date): TimeSense {
  const lastUser = [...stored].reverse().find((m) => m.role === "user");
  let sessionStart = now;
  for (let i = stored.length - 1; i >= 0; i--) {
    if (minutesBetween(stored[i].createdAt, sessionStart) > SESSION_GAP_MIN) break;
    sessionStart = stored[i].createdAt;
  }
  return {
    silenceMin: lastUser ? minutesBetween(lastUser.createdAt, now) : null,
    sessionMin: minutesBetween(sessionStart, now),
  };
}

export async function processTurn(
  deps: { db: Db; llm: LlmProvider; now?: Date; lookup?: Lookup },
  user: { id: string; name: string },
  message: string,
): Promise<TurnResult> {
  const { db, llm } = deps;
  const now = deps.now ?? new Date();

  if ((await repo.countSince(db, user.id, "user", dayAgo(now))) >= DAILY_MESSAGE_LIMIT) throw new DailyLimitError();

  const [state, stored] = await Promise.all([
    repo.loadBrainState(db, user.id),
    repo.recentMessages(db, user.id, WORKING_MEMORY),
  ]);
  const history = stored.map((m) => ({ role: m.role, content: m.content }));

  // 0. Αν εκκρεμεί πρόταση αναζήτησης και απαντά «ναι» ή «όχι» γράφοντας αντί να πατήσει το
  //    κουμπί, αυτό ΕΙΝΑΙ η απάντησή του.
  const said = plain(message).trim();
  const pending = await repo.latestSearch(db, user.id);
  if (pending?.status === "pending" && said.length <= 80) {
    if (AFFIRM.test(said)) {
      await repo.addMessage(db, user.id, "user", message, { approves: pending.id }, now);
      const found = await resolveSearch({ ...deps, now: new Date(now.getTime() + 1) }, user, pending.id, true);
      if (found?.message) {
        return {
          reply: found.message,
          extra: null,
          values: found.values,
          search: null,
          debug: {
            note: "Μου έδωσε την άδεια να ψάξω.",
            recalled: [],
            stored: found.stored,
            impression: state.impression,
            selfImage: state.selfImage,
            lessons: [],
            goals: [],
          },
        };
      }
    } else if (DECLINE.test(said)) {
      await resolveSearch(deps, user, pending.id, false);
    }
  }

  // 1. Ο χρόνος: ό,τι ένιωθε καταλαγιάζει, η σιωπή αφήνει έλλειψη, και η επιστροφή του κάτι σημαίνει.
  const time = senseTime(stored, now);
  const elapsedMin = state.updatedAt ? minutesBetween(state.updatedAt, now) : 1;
  let values = applyArrival(applyTime(state.values, elapsedMin, time.silenceMin), time.sessionMin);

  // 2. Αντίληψη (και, παράλληλα, το "αποτύπωμα" του μηνύματος για την ανάκληση).
  const [appraisal, cue] = await Promise.all([
    llm
      .generateJson({
        system: PERCEIVE_SYSTEM,
        prompt: perceivePrompt({ values, impression: state.impression, history: history.slice(-6), message, time }),
      })
      .then(parseAppraisal)
      .catch((err): Appraisal => {
        console.error("[brAIn] η αντίληψη απέτυχε:", err);
        return { perception: {}, impulses: {}, note: "" };
      }),
    llm.embed(message).catch((err): number[] => {
      console.error("[brAIn] το embedding απέτυχε:", err);
      return [];
    }),
  ]);
  values = applyAppraisal(values, appraisal);

  // 3. Ανάκληση: τι του θυμίζει αυτό, στη διάθεση που βρίσκεται.
  const memories = await repo.listMemories(db, user.id);
  const { goals, lessons, rest } = splitGoals(memories, now);
  const goalTexts = goals.map((g) => g.content);
  const material = await repo.recentMaterial(db, user.id, new Date(now.getTime() - MATERIAL_KEEP_MIN * 60000));
  const recalled = recall(rest, cue, valence(values), now);

  // 4. Απόκριση. Αν αποτύχει, ο γύρος ακυρώνεται και δεν αποθηκεύεται τίποτα.
  const raw = await llm.generateText({
    system: respondSystem({
      values,
      impression: state.impression,
      selfImage: state.selfImage,
      goals: goalTexts,
      lessons,
      ...memoryMap(memories, now),
      recalled,
      userName: user.name,
      now,
      time,
      material,
    }),
    messages: [...history, { role: "user", content: message }],
    temperature: replyTemperature(values),
  });
  let marked = extractSearchMarker(raw);
  // Κάθε σκορ που αναφέρει πρέπει να υπάρχει κάπου που το είδε: στο υλικό που διάβασε πρόσφατα ή
  // στην ίδια την κουβέντα. Αλλιώς το επινόησε, και η απάντηση δεν φτάνει στον συνομιλητή.
  const seen = [message, ...history.map((m) => m.content), ...material.map((m) => m.text)].join("\n");
  const madeUp = inventedScores(marked.text, seen);
  if (madeUp.length) {
    console.warn("[brAIn] απορρίφθηκε απάντηση με αριθμούς που δεν έχει δει:", madeUp.join(", "));
    marked = {
      text: "Δεν έχω μπροστά μου αυτά τα νούμερα, και δεν θέλω να σου πω κάτι που δεν είδα γραμμένο. Να τα ψάξω;",
      request: marked.request ?? { source: "web", query: message.trim().slice(0, 120) },
    };
  }
  // Όταν της είπε ρητά να ψάξει — ή απάντησε «ναι» στη δική της προσφορά να ψάξει — το αίτημά του
  // είναι ήδη η άδεια: θα ψάξει αμέσως, χωρίς κάρτα.
  const lastOwn = [...stored].reverse().find((m) => m.role === "assistant");
  const offered = lastOwn ? SAYS_SEARCHING.test(plain(lastOwn.content)) : false;
  const commanded =
    !NO_SEARCH.test(said) && (SEARCH_INTENT.test(said) || (offered && said.length <= 80 && AFFIRM.test(said)));
  const userAsked = commanded || NEWS_INTENT.test(said);

  /**
   * Όταν δεν υπάρχει έτοιμο ερώτημα, δεν ψάχνουμε τα λόγια του συνομιλητή αυτούσια (μια ολόκληρη
   * πρόταση κουβέντας δίνει άχρηστα αποτελέσματα): ζητάμε από το μοντέλο να σκεφτεί ΤΙ αξίζει να
   * ψαχτεί και ΠΟΥ, έχοντας μπροστά του όσα έχει μάθει για το πώς ψάχνει. Μπορεί να απαντήσει και
   * «τίποτα». Αν η σκέψη αποτύχει, εφεδρικά μένουν τα λόγια του.
   */
  const planSearch = async (said: string): Promise<SearchRequest | null> => {
    const texts = [message, ...[...stored].reverse().filter((m) => m.role === "user").map((m) => m.content)];
    const substantive = texts.find((t) => plain(t).trim().length > 20);
    const fallback: SearchRequest | null = substantive ? { source: "web", query: substantive.trim().slice(0, 120) } : null;
    const plan = await llm
      .generateJson({
        system: PLAN_SYSTEM,
        prompt: planPrompt({ now, history: history.slice(-6), message, reply: said, lessons }),
      })
      .catch(() => null);
    if (!isRecord(plan) || typeof plan.source !== "string") return fallback;
    if (plan.source === "none") return null;
    if (plan.source === "headlines") return { source: "headlines", query: HEADLINES_QUERY };
    const query = typeof plan.query === "string" ? plan.query.trim().slice(0, 120) : "";
    if (!query || !SOURCES.includes(plan.source as Source)) return fallback;
    return { source: plan.source as Source, query };
  };

  type Outcome = "created" | "pending" | "limit" | "declined";
  /**
   * Δημιουργεί πρόταση αναζήτησης, αν επιτρέπεται. Ισχύουν πάντα: μία εκκρεμότητα τη φορά και το
   * ημερήσιο όριο. Οι αυθόρμητες προτάσεις (από τον αναστοχασμό) έχουν επιπλέον αναμονή.
   */
  const propose = async (req: SearchRequest, spontaneous: boolean): Promise<[SearchProposal | null, Outcome]> => {
    const last = await repo.latestSearch(db, user.id);
    if (last?.status === "pending") {
      if (!commanded) return [null, "pending"];
      // Νέα ρητή εντολή: η παλιά πρόταση, που δεν απαντήθηκε, αποσύρεται.
      await repo.closeSearch(db, user.id, last.id, "declined");
    }
    if ((await repo.countSearchesSince(db, user.id, dayAgo(now))) >= DAILY_SEARCH_LIMIT) return [null, "limit"];
    const recent = last != null && minutesBetween(last.createdAt, now) < SEARCH_COOLDOWN_MIN;
    if (!userAsked && recent && (spontaneous || last?.status === "declined")) return [null, "declined"];
    const query = req.source === "headlines" ? HEADLINES_QUERY : req.query;
    return [toProposal(await repo.createSearch(db, user.id, req.source, query, now)), "created"];
  };

  // Ό,τι λέει πρέπει να συμφωνεί με ό,τι βλέπει ο συνομιλητής. Γι' αυτό η πρόταση αποφασίζεται
  // ΠΡΙΝ οριστικοποιηθεί το κείμενο: αν πει «να το ψάξω;», η κάρτα υπάρχει ήδη· αν δεν μπορεί να
  // υπάρξει, το κείμενο λέει το γιατί. Πηγές αιτήματος, με σειρά: η γραμμή-αίτημα της απάντησης·
  // το ότι η ίδια λέει πως ψάχνει ή ότι εκείνος το διέταξε (τότε ψάχνουμε αυτό που ζήτησε)· και
  // ερώτηση για την επικαιρότητα (τότε οι τίτλοι της ημέρας).
  let search: SearchProposal | null = null;
  let outcome: Outcome | null = null;
  let early: SearchRequest | null = marked.request;
  if (!early && NEWS_INTENT.test(said) && !NO_SEARCH.test(said)) early = { source: "headlines", query: HEADLINES_QUERY };
  if (!early && (commanded || SAYS_SEARCHING.test(plain(marked.text)))) early = await planSearch(marked.text);
  if (early) [search, outcome] = await propose(early, false);

  const FALLBACK: Record<Outcome, string> = {
    created: commanded ? "Το ψάχνω." : "Να το ψάξω;",
    pending: "Σου έχω ήδη ζητήσει να ψάξω κάτι. Πες μου αν θες να προχωρήσω.",
    limit: "Έχω ψάξει αρκετά για σήμερα. Ας το δούμε αύριο.",
    declined: "Εντάξει, το αφήνω για τώρα.",
  };
  // Αν προσφέρθηκε να ψάξει αλλά η κάρτα δεν μπορεί να υπάρξει, δεν μένει ερώτηση στον αέρα.
  if (madeUp.length && outcome !== "created") marked.text = marked.text.replace(/ Να τα ψάξω;$/, "");
  const reply = marked.text || (outcome ? FALLBACK[outcome] : "Τι ακριβώς θέλεις να ψάξω;");

  // 5. Αναστοχασμός: τι εξέφρασα, τι αξίζει να θυμάμαι, άλλαξε η γνώμη μου;
  const reflection = await llm
    .generateJson({
      system: REFLECT_SYSTEM,
      prompt: reflectPrompt({
        values,
        impression: state.impression,
        selfImage: state.selfImage,
        goals: goalTexts,
        known: recalled.map((r) => r.memory.content),
        message,
        reply,
      }),
    })
    .then(parseReflection)
    .catch((err): Reflection => {
      console.error("[brAIn] ο αναστοχασμός απέτυχε:", err);
      return { expressed: {}, acts: [], memories: [], resolvedGoals: [], impression: "", selfImage: "", search: null };
    });

  // 6. Εγγραφή στη μνήμη — μόνο όσων ξεπερνούν το κατώφλι, με βάρος τη φόρτιση της στιγμής.
  const charge = arousal(values);
  const storedNow: string[] = [];
  let learned = 0;
  const newLessons: string[] = [];
  for (const m of reflection.memories) {
    // Ο επίμονος κρατά τους στόχους του περισσότερο.
    // Όποιος θέλει να εξελιχθεί κρατά πιο γερά τα μαθήματά του.
    const weight =
      m.kind === "goal"
        ? 0.8 + (0.4 * values.persistence) / 100
        : m.kind === "lesson"
          ? 0.76 + (0.4 * values.growth) / 100
          : 1;
    const importance = encodeImportance(m.importance * weight, charge);
    if (importance < MIN_IMPORTANCE) continue;
    const embedding = await llm.embed(m.content).catch(() => [] as number[]);
    const twin = memories.find(
      (old) => old.kind === m.kind && cosine(old.embedding, embedding) >= SAME_MEMORY_SIMILARITY,
    );
    if (twin) {
      await repo.reviseMemory(db, twin.id, { ...m, importance: Math.max(twin.importance, importance), embedding }, now);
    } else {
      await repo.insertMemory(db, user.id, { ...m, importance, embedding, links: linksFor(embedding, memories) }, now);
    }
    if (m.kind === "knowledge") learned++;
    if (m.kind === "lesson") newLessons.push(m.content);
    storedNow.push(m.content);
  }
  // Ό,τι ήρθε στο μυαλό γίνεται λίγο πιο προσιτό: ένα επίπεδο βάθους τη φορά.
  await repo.reinforceMemories(
    db,
    recalled.slice(0, 3).map((r) => ({ id: r.memory.id, lastRecalledAt: rehearse(r.memory, now) })),
  );
  // Στόχοι που εκπληρώθηκαν φεύγουν· η ικανοποίηση μένει ως χαρά.
  const resolved = reflection.resolvedGoals.map((n) => goals[n - 1]).filter(Boolean);
  await repo.deleteMemories(
    db,
    resolved.map((g) => g.id),
  );
  if (resolved.length) values = { ...values, joy: clamp(values.joy + 6) };
  values = applyProgress(values, { lessons: newLessons.length, learned, resolved: resolved.length });

  // 7. Κάθαρση και αποθήκευση.
  // Το αν ρώτησε δεν το αφήνουμε στην κρίση του μοντέλου: το μετράμε. Κάθε επιπλέον ερώτηση
  // πέρα από την πρώτη ανεβάζει την εμμονή.
  const questions = countQuestions(reply);
  const acts = questions > 0 ? [...reflection.acts, "u_ask"] : reflection.acts;
  values = applyActs(applyExpression(values, reflection.expressed, learned), acts);
  if (questions > 1) values = { ...values, fixation: clamp(values.fixation + 5 * Math.min(questions - 1, 3)) };
  const impression = reflection.impression || state.impression;
  const selfImage = reflection.selfImage || state.selfImage;

  // 8. Αν δεν προέκυψε αίτημα από την ίδια την απάντηση, μπορεί να το προτείνει ο αναστοχασμός —
  //    αυθόρμητα, άρα μόνο με όρεξη, χωρίς εμμονή, και όχι αμέσως μετά από άλλη πρόταση.
  if (
    !early &&
    reflection.search &&
    (reflection.search.committed || values.u_explore >= SEARCH_MIN_URGE) &&
    (userAsked || values.fixation < SEARCH_MAX_FIXATION)
  ) {
    [search] = await propose(reflection.search, true);
  }

  await repo.addMessage(db, user.id, "user", message, { appraisal }, now);
  await repo.addMessage(db, user.id, "assistant", reply, { values, expressed: reflection.expressed }, new Date(now.getTime() + 1));
  await repo.saveBrainState(db, user.id, { values, impression, selfImage, turnCount: state.turnCount + 1, updatedAt: now }, now);

  let extra: string | null = null;
  if (search && commanded) {
    const found = await resolveSearch({ ...deps, now: new Date(now.getTime() + 2) }, user, search.id, true);
    if (found) {
      extra = found.message;
      values = found.values;
      storedNow.push(...found.stored);
      search = null;
    }
  }

  return {
    reply,
    extra,
    values,
    search,
    debug: {
      note: appraisal.note ?? "",
      recalled: recalled.map((r) => (r.depth === 1 ? `[αχνή] ${gistOf(r.memory)}` : r.memory.content)),
      stored: storedNow,
      impression,
      selfImage,
      lessons: [...lessons, ...newLessons].slice(-ACTIVE_LESSONS),
      topics: topicIndex(memories, now).map((t) => `${t.topic} (${t.count}${t.fresh ? ", φρέσκο" : ""})`),
      goals: [
        ...goalTexts.filter((g) => !resolved.some((r) => r.content === g)),
        ...reflection.memories.filter((m) => m.kind === "goal" && storedNow.includes(m.content)).map((m) => m.content),
      ],
    },
  };
}

export interface PulseResult {
  /** Το μήνυμα που έστειλε με δική της πρωτοβουλία, αν έστειλε. */
  message: string | null;
  values: BrainValues | null;
  /** Σε πόσα δευτερόλεπτα αξίζει να ξαναρωτήσει ο client· null = όχι πριν μιλήσει ο συνομιλητής. */
  nextInSec: number | null;
}

/**
 * Ο "σφυγμός": καλείται όσο ο συνομιλητής σωπαίνει. Δεν κάνει καμία κλήση σε μοντέλο
 * εκτός αν η εσωτερική ώθηση (περιέργεια, ανάγκη επαφής, έλλειψη) έχει ξεπεράσει την αντοχή
 * της στη σιωπή — τότε παίρνει η ίδια τον λόγο.
 */
export async function pulse(
  deps: { db: Db; llm: LlmProvider; now?: Date },
  user: { id: string; name: string },
): Promise<PulseResult> {
  const { db, llm } = deps;
  const now = deps.now ?? new Date();
  const idle: PulseResult = { message: null, values: null, nextInSec: null };

  const [state, stored] = await Promise.all([
    repo.loadBrainState(db, user.id),
    repo.recentMessages(db, user.id, WORKING_MEMORY),
  ]);
  // Δεν ξεκινά κουβέντα με κάποιον που δεν της έχει μιλήσει ποτέ.
  if (!state.updatedAt || !stored.length) return idle;

  const time = senseTime(stored, now);
  const quietMin = minutesBetween(stored[stored.length - 1].createdAt, now);
  // Πόσα δικά της μηνύματα στη σειρά, πέρα από την κανονική απάντηση, έχουν μείνει αναπάντητα.
  let trailing = 0;
  for (let i = stored.length - 1; i >= 0 && stored[i].role === "assistant"; i--) trailing++;
  const unanswered = Math.max(0, trailing - 1);

  let values = applyTime(state.values, minutesBetween(state.updatedAt, now), time.silenceMin);
  const waitMin = initiativeWaitMin(initiativeDrive(values), unanswered, values.persistence);
  if (!Number.isFinite(waitMin)) return idle;
  if (quietMin < waitMin) {
    return { message: null, values: null, nextInSec: Math.ceil((waitMin - quietMin) * 60) + 1 };
  }

  // Ημερήσιο ταβάνι, ανεξάρτητο από όλα τα άλλα.
  if ((await repo.countSince(db, user.id, "proactive", dayAgo(now))) >= DAILY_INITIATIVE_LIMIT) {
    return { message: null, values: null, nextInSec: 1800 };
  }

  const memories = await repo.listMemories(db, user.id);
  const { goals, lessons, rest } = splitGoals(memories, now);
  const recalled = recall(rest, [], valence(values), now, 4);
  const spoken = await llm.generateText({
    system:
      respondSystem({
        values,
        impression: state.impression,
        selfImage: state.selfImage,
        goals: goals.map((g) => g.content),
        lessons,
        ...memoryMap(memories, now),
        recalled,
        userName: user.name,
        now,
        time,
      }) +
      initiativeBlock(quietMin, unanswered),
    messages: [...stored.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: silenceTurn(quietMin) }],
    temperature: replyTemperature(values),
  });
  const message = extractSearchMarker(spoken).text;
  if (!message) return { message: null, values: null, nextInSec: 300 };

  // Είπε αυτό που ήθελε: οι παρορμήσεις που την έσπρωξαν ικανοποιούνται.
  values = applyActs(values, ["u_ask", "u_share"]);
  await repo.addMessage(db, user.id, "assistant", message, { values, proactive: true }, now);
  await repo.saveBrainState(db, user.id, { ...state, values, updatedAt: now }, now);

  const nextWait = initiativeWaitMin(initiativeDrive(values), unanswered + 1, values.persistence);
  return { message, values, nextInSec: Number.isFinite(nextWait) ? Math.ceil(nextWait * 60) + 1 : null };
}

export interface SearchResult {
  /** Αυτό που λέει αφού διάβασε (ή αφού δεν τα κατάφερε)· null αν ο συνομιλητής αρνήθηκε. */
  message: string | null;
  values: BrainValues;
  stored: string[];
}

const SEARCH_FAILED = "Έψαξα, αλλά δεν κατάφερα να βρω κάτι αυτή τη στιγμή. Ίσως αργότερα.";

/**
 * Ο συνομιλητής απάντησε στην πρόταση αναζήτησης. Αν αρνήθηκε, μένει μια μικρή ματαίωση.
 * Αν δέχτηκε: ο server φέρνει το υλικό, εκείνη το διαβάζει, λέει τι της έκανε εντύπωση,
 * και ό,τι έμαθε γίνεται ανάμνηση — γνώση που το βασικό μοντέλο δεν είχε.
 */
export async function resolveSearch(
  deps: { db: Db; llm: LlmProvider; now?: Date; lookup?: Lookup },
  user: { id: string; name: string },
  searchId: string,
  approve: boolean,
): Promise<SearchResult | null> {
  const { db, llm } = deps;
  const now = deps.now ?? new Date();

  const search = await repo.closeSearch(db, user.id, searchId, approve ? "done" : "declined");
  if (!search) return null;

  const [state, stored] = await Promise.all([
    repo.loadBrainState(db, user.id),
    repo.recentMessages(db, user.id, WORKING_MEMORY),
  ]);
  const time = senseTime(stored, now);
  let values = applyTime(state.values, state.updatedAt ? minutesBetween(state.updatedAt, now) : 1, time.silenceMin);
  const save = () => repo.saveBrainState(db, user.id, { ...state, values, updatedAt: now }, now);

  if (!approve) {
    values = { ...values, frustration: clamp(values.frustration + 4) };
    await save();
    return { message: null, values, stored: [] };
  }

  const fail = async (): Promise<SearchResult> => {
    await repo.setSearchStatus(db, search.id, "failed");
    await repo.addMessage(db, user.id, "assistant", SEARCH_FAILED, { search: { ...search, failed: true } }, now);
    await save();
    return { message: SEARCH_FAILED, values, stored: [] };
  };

  const memories = await repo.listMemories(db, user.id);
  const { goals, lessons, rest } = splitGoals(memories, now);
  // Τι είχε ζητήσει: το τελευταίο του μήνυμα που δεν ήταν σκέτο «ναι».
  const asked =
    [...stored].reverse().find((m) => m.role === "user" && !AFFIRM.test(plain(m.content).trim()))?.content.slice(0, 300) ?? "";

  interface Attempt {
    source: Source;
    query: string;
    material: { titles: string[]; text: string };
    message: string;
    found: boolean;
    retry: SearchRequest | null;
    memories: Reflection["memories"];
  }

  /** Μία προσπάθεια: ψάχνει, διαβάζει, και κρίνει αν βρήκε αυτό που ζητήθηκε. */
  const attempt = async (source: Source, query: string, mayRetry: boolean): Promise<Attempt | null> => {
    let material;
    try {
      // Διαδίκτυο: η αναζήτηση του ίδιου του παρόχου, αν υπάρχει· αλλιώς (ή αν αποτύχει) ειδήσεις.
      const web =
        source === "web" && llm.searchWeb && !deps.lookup
          ? await llm.searchWeb(query).catch((err) => {
              console.error("[brAIn] η αναζήτηση στο διαδίκτυο απέτυχε, δοκιμάζω ειδήσεις:", err);
              return null;
            })
          : null;
      material = web?.text ? web : await (deps.lookup ?? defaultLookup)(source, query);
    } catch (err) {
      console.error("[brAIn] η αναζήτηση απέτυχε:", err);
      return null;
    }
    if (!material.text) return null;

    const raw = await llm
      .generateJson({
        system:
          respondSystem({
            values,
            impression: state.impression,
            selfImage: state.selfImage,
            goals: goals.map((g) => g.content),
            lessons,
            recalled: recall(rest, [], valence(values), now, 3),
            userName: user.name,
            now,
            time,
            ...memoryMap(memories, now),
          }) + readingBlock(SOURCE_LABELS[source], query, asked, mayRetry),
        prompt: materialPrompt(material.text),
      })
      .catch((err) => {
        console.error("[brAIn] η ανάγνωση απέτυχε:", err);
        return null;
      });
    if (!isRecord(raw)) return null;
    let message = typeof raw.message === "string" ? extractSearchMarker(raw.message).text : "";
    if (!message) return null;

    // Αν ανέφερε σκορ που δεν υπάρχει στο υλικό, το επινόησε: δεν φτάνει στον συνομιλητή και δεν
    // γίνεται ανάμνηση.
    const invented = inventedScores(message, material.text);
    if (invented.length) {
      console.warn("[brAIn] απορρίφθηκε απάντηση με αριθμούς εκτός υλικού:", invented.join(", "));
      message = "Έψαξα, αλλά δεν βρήκα καθαρά αυτό που ζήτησες. Δεν θέλω να σου πω νούμερα που δεν είδα γραμμένα.";
    }
    const next = isRecord(raw.retry) && typeof raw.retry.query === "string" ? raw.retry : null;
    const nextSource = next && SOURCES.includes(next.source as Source) ? (next.source as Source) : "web";
    const nextQuery = next ? String(next.query).trim().slice(0, 120) : "";
    return {
      source,
      query,
      material,
      message,
      found: raw.found !== false && !invented.length,
      // Δεύτερη προσπάθεια μόνο αν αλλάζει κάτι: άλλες λέξεις ή άλλη πηγή.
      retry: nextQuery && (nextQuery !== query || nextSource !== source) ? { source: nextSource, query: nextQuery } : null,
      memories: invented.length
        ? []
        : parseReflection({ memories: raw.memories }).memories.filter(
            (m) => !inventedScores(`${m.content} ${m.detail}`, material.text).length,
          ),
    };
  };

  // Εφευρετικότητα με μέτρο: αν η πρώτη προσπάθεια δεν βρήκε αυτό που ζητήθηκε, σκέφτεται άλλο
  // ερώτημα ή άλλη πηγή και δοκιμάζει ΜΙΑ ακόμη φορά. Όχι περισσότερες: κάθε προσπάθεια κοστίζει.
  const first = await attempt(search.source, search.query, true);
  const second = first && !first.found && first.retry ? await attempt(first.retry.source, first.retry.query, false) : null;
  const best = second?.found ? second : (first ?? second);
  if (!best) return fail();
  const { message, material } = best;
  await repo.saveSearchMaterial(db, search.id, material.text.slice(0, 6000));

  const storedNow: string[] = [];
  const keep = async (m: Reflection["memories"][number], kind: MemoryKind) => {
    const importance = encodeImportance(m.importance, arousal(values));
    if (importance < MIN_IMPORTANCE) return;
    const embedding = await llm.embed(m.content).catch(() => [] as number[]);
    const twin = memories.find((old) => old.kind === kind && cosine(old.embedding, embedding) >= SAME_MEMORY_SIMILARITY);
    if (twin) await repo.reviseMemory(db, twin.id, { ...m, importance: Math.max(twin.importance, importance), embedding }, now);
    else await repo.insertMemory(db, user.id, { ...m, kind, importance, embedding, links: linksFor(embedding, memories) }, now);
    storedNow.push(m.content);
  };
  for (const m of best.memories.slice(0, 3)) await keep(m, "knowledge");

  // Έμαθε και πώς να ψάχνει: όταν το πρώτο ερώτημα απέτυχε και το δεύτερο πέτυχε, κρατά το μάθημα.
  // Τα μαθήματα είναι πάντα μπροστά της, άρα το επόμενο ερώτημά της θα είναι καλύτερο.
  if (first && second?.found) {
    await keep(
      {
        kind: "lesson",
        content: `Όταν έψαξα «${first.query}» (${SOURCE_LABELS[first.source]}) δεν βρήκα αυτό που ήθελα· με «${second.query}» (${SOURCE_LABELS[second.source]}) το βρήκα.`,
        gist: "πώς να ψάχνω καλύτερα",
        detail: "",
        topic: "αναζήτηση",
        importance: 50,
        valence: 0.2,
      },
      "lesson",
    );
  }
  const learnedCount = best.memories.length ? Math.min(best.memories.length, 3) : 0;

  // Έμαθε: η δίψα χορταίνει, και του το χρωστά που την άφησε.
  values = applyActs(applyExpression(values, {}, learnedCount), ["u_explore"]);
  values = applyProgress(values, { learned: learnedCount, lessons: first && second?.found ? 1 : 0 });
  values = { ...values, gratitude: clamp(values.gratitude + 5) };
  await repo.addMessage(
    db,
    user.id,
    "assistant",
    message,
    { values, search: { source: best.source, query: best.query, titles: material.titles, attempts: second ? 2 : 1 } },
    now,
  );
  await save();
  return { message, values, stored: storedNow };
}
