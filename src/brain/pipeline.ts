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
  recall,
  strength,
  type Memory,
  type MemoryKind,
} from "./memory";
import { SOURCE_LABELS, lookup as defaultLookup, type Lookup, type Source } from "./world";
import {
  PERCEIVE_SYSTEM,
  REFLECT_SYSTEM,
  initiativeBlock,
  materialPrompt,
  readingBlock,
  perceivePrompt,
  reflectPrompt,
  respondSystem,
  silenceTurn,
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
  memories: { kind: MemoryKind; content: string; importance: number; valence: number }[];
  resolvedGoals: number[];
  impression: string;
  selfImage: string;
  search: { source: Source; query: string; committed: boolean } | null;
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
    selfImage: typeof r.self_image === "string" ? r.self_image.trim().slice(0, 800) : "",
    search:
      isRecord(r.search) && typeof r.search.query === "string" && r.search.query.trim()
        ? {
            source: r.search.source === "news" ? "news" : "wikipedia",
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
  deps: { db: Db; llm: LlmProvider; now?: Date },
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
  const recalled = recall(rest, cue, valence(values), now);

  // 4. Απόκριση. Αν αποτύχει, ο γύρος ακυρώνεται και δεν αποθηκεύεται τίποτα.
  const reply = await llm.generateText({
    system: respondSystem({
      values,
      impression: state.impression,
      selfImage: state.selfImage,
      goals: goalTexts,
      lessons,
      recalled,
      userName: user.name,
      now,
      time,
    }),
    messages: [...history, { role: "user", content: message }],
    temperature: replyTemperature(values),
  });

  // 5. Αναστοχασμός: τι εξέφρασα, τι αξίζει να θυμάμαι, άλλαξε η γνώμη μου;
  const reflection = await llm
    .generateJson({
      system: REFLECT_SYSTEM,
      prompt: reflectPrompt({
        values,
        impression: state.impression,
        selfImage: state.selfImage,
        goals: goalTexts,
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
      await repo.reviseMemory(
        db,
        twin.id,
        { content: m.content, importance: Math.max(twin.importance, importance), valence: m.valence, embedding },
        now,
      );
    } else {
      await repo.insertMemory(db, user.id, { ...m, importance, embedding }, now);
    }
    if (m.kind === "knowledge") learned++;
    if (m.kind === "lesson") newLessons.push(m.content);
    storedNow.push(m.content);
  }
  await repo.reinforceMemories(
    db,
    recalled.slice(0, 3).map((r) => r.memory.id),
    now,
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

  // 8. Θέλει να ψάξει κάτι; Μόνο αν έχει όρεξη, δεν ζήτησε πρόσφατα, και δεν ξεπέρασε το ημερήσιο όριο.
  let search: SearchProposal | null = null;
  // Όταν το ζήτησε ο συνομιλητής ή το είπε η ίδια στην απάντησή της, οι φραγμοί όρεξης, εμμονής
  // και αναμονής δεν ισχύουν: θα ήταν παράλογο να πει «να ψάξω;» και να μη φανεί η επιλογή.
  const wanted =
    reflection.search &&
    (reflection.search.committed ||
      (values.u_explore >= SEARCH_MIN_URGE && values.fixation < SEARCH_MAX_FIXATION));
  if (reflection.search && wanted) {
    const last = await repo.latestSearch(db, user.id);
    const recently =
      last &&
      (last.status === "pending" ||
        (!reflection.search.committed && minutesBetween(last.createdAt, now) < SEARCH_COOLDOWN_MIN));
    if (!recently && (await repo.countSearchesSince(db, user.id, dayAgo(now))) < DAILY_SEARCH_LIMIT) {
      search = toProposal(await repo.createSearch(db, user.id, reflection.search.source, reflection.search.query, now));
    }
  }

  await repo.addMessage(db, user.id, "user", message, { appraisal }, now);
  await repo.addMessage(db, user.id, "assistant", reply, { values, expressed: reflection.expressed }, new Date(now.getTime() + 1));
  await repo.saveBrainState(db, user.id, { values, impression, selfImage, turnCount: state.turnCount + 1, updatedAt: now }, now);

  return {
    reply,
    values,
    search,
    debug: {
      note: appraisal.note ?? "",
      recalled: recalled.map((r) => r.memory.content),
      stored: storedNow,
      impression,
      selfImage,
      lessons: [...lessons, ...newLessons].slice(-ACTIVE_LESSONS),
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
  const message = await llm.generateText({
    system:
      respondSystem({
        values,
        impression: state.impression,
        selfImage: state.selfImage,
        goals: goals.map((g) => g.content),
        lessons,
        recalled,
        userName: user.name,
        now,
        time,
      }) +
      initiativeBlock(quietMin, unanswered),
    messages: [...stored.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: silenceTurn(quietMin) }],
    temperature: replyTemperature(values),
  });

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

  let material;
  try {
    material = await (deps.lookup ?? defaultLookup)(search.source, search.query);
  } catch (err) {
    console.error("[brAIn] η αναζήτηση απέτυχε:", err);
    return fail();
  }
  if (!material.text) return fail();

  const memories = await repo.listMemories(db, user.id);
  const { goals, lessons, rest } = splitGoals(memories, now);
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
        }) + readingBlock(SOURCE_LABELS[search.source], search.query),
      prompt: materialPrompt(material.text),
    })
    .catch((err) => {
      console.error("[brAIn] η ανάγνωση απέτυχε:", err);
      return null;
    });
  const message = isRecord(raw) && typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) return fail();

  const learned = parseReflection({ memories: isRecord(raw) ? raw.memories : [] }).memories.slice(0, 3);
  const storedNow: string[] = [];
  for (const m of learned) {
    const importance = encodeImportance(m.importance, arousal(values));
    if (importance < MIN_IMPORTANCE) continue;
    const embedding = await llm.embed(m.content).catch(() => [] as number[]);
    await repo.insertMemory(db, user.id, { ...m, kind: "knowledge", importance, embedding }, now);
    storedNow.push(m.content);
  }

  // Έμαθε: η δίψα χορταίνει, και του το χρωστά που την άφησε.
  values = applyActs(applyExpression(values, {}, storedNow.length), ["u_explore"]);
  values = applyProgress(values, { learned: storedNow.length });
  values = { ...values, gratitude: clamp(values.gratitude + 5) };
  await repo.addMessage(
    db,
    user.id,
    "assistant",
    message,
    { values, search: { source: search.source, query: search.query, titles: material.titles } },
    now,
  );
  await save();
  return { message, values, stored: storedNow };
}
