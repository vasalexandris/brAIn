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
import { INNER_KEYS, PERCEPTION_KEYS } from "./dimensions";
import {
  MIN_IMPORTANCE,
  SAME_MEMORY_SIMILARITY,
  cosine,
  encodeImportance,
  recall,
  type MemoryKind,
} from "./memory";
import { PERCEIVE_SYSTEM, REFLECT_SYSTEM, perceivePrompt, reflectPrompt, respondSystem } from "./prompts";
import {
  applyAppraisal,
  applyExpression,
  arousal,
  clamp,
  decay,
  valence,
  type Appraisal,
  type BrainValues,
} from "./state";

/** Πόσα πρόσφατα μηνύματα μένουν στην "άμεση" μνήμη εργασίας. */
const WORKING_MEMORY = 16;
const MEMORY_KINDS: MemoryKind[] = ["user_fact", "episode", "knowledge", "opinion"];

export interface TurnResult {
  reply: string;
  values: BrainValues;
  debug: {
    note: string;
    recalled: string[];
    stored: string[];
    impression: string;
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
  memories: { kind: MemoryKind; content: string; importance: number; valence: number }[];
  impression: string;
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
    memories,
    impression: typeof r.impression === "string" ? r.impression.trim().slice(0, 600) : "",
  };
}

export async function processTurn(
  deps: { db: Db; llm: LlmProvider; now?: Date },
  user: { id: string; name: string },
  message: string,
): Promise<TurnResult> {
  const { db, llm } = deps;
  const now = deps.now ?? new Date();

  const [state, stored] = await Promise.all([
    repo.loadBrainState(db, user.id),
    repo.recentMessages(db, user.id, WORKING_MEMORY),
  ]);
  const history = stored.map((m) => ({ role: m.role, content: m.content }));

  // 1. Ο χρόνος που πέρασε από την τελευταία κουβέντα καταλαγιάζει τα πράγματα.
  const elapsedMin = state.updatedAt ? (now.getTime() - state.updatedAt.getTime()) / 60000 : 1;
  let values = decay(state.values, elapsedMin);

  // 2. Αντίληψη (και, παράλληλα, το "αποτύπωμα" του μηνύματος για την ανάκληση).
  const [appraisal, cue] = await Promise.all([
    llm
      .generateJson({
        system: PERCEIVE_SYSTEM,
        prompt: perceivePrompt({ values, impression: state.impression, history: history.slice(-6), message }),
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
  const recalled = recall(memories, cue, valence(values), now);

  // 4. Απόκριση. Αν αποτύχει, ο γύρος ακυρώνεται και δεν αποθηκεύεται τίποτα.
  const reply = await llm.generateText({
    system: respondSystem({ values, impression: state.impression, recalled, userName: user.name, now }),
    messages: [...history, { role: "user", content: message }],
    temperature: 0.9,
  });

  // 5. Αναστοχασμός: τι εξέφρασα, τι αξίζει να θυμάμαι, άλλαξε η γνώμη μου;
  const reflection = await llm
    .generateJson({
      system: REFLECT_SYSTEM,
      prompt: reflectPrompt({ values, impression: state.impression, message, reply }),
    })
    .then(parseReflection)
    .catch((err): Reflection => {
      console.error("[brAIn] ο αναστοχασμός απέτυχε:", err);
      return { expressed: {}, memories: [], impression: "" };
    });

  // 6. Εγγραφή στη μνήμη — μόνο όσων ξεπερνούν το κατώφλι, με βάρος τη φόρτιση της στιγμής.
  const charge = arousal(values);
  const storedNow: string[] = [];
  let learned = 0;
  for (const m of reflection.memories) {
    const importance = encodeImportance(m.importance, charge);
    if (importance < MIN_IMPORTANCE) continue;
    const embedding = await llm.embed(m.content).catch(() => [] as number[]);
    const twin = memories.find((old) => cosine(old.embedding, embedding) >= SAME_MEMORY_SIMILARITY);
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
    storedNow.push(m.content);
  }
  await repo.reinforceMemories(
    db,
    recalled.slice(0, 3).map((r) => r.memory.id),
    now,
  );

  // 7. Κάθαρση και αποθήκευση.
  values = applyExpression(values, reflection.expressed, learned);
  const impression = reflection.impression || state.impression;

  await repo.addMessage(db, user.id, "user", message, { appraisal }, now);
  await repo.addMessage(db, user.id, "assistant", reply, { values, expressed: reflection.expressed }, new Date(now.getTime() + 1));
  await repo.saveBrainState(db, user.id, { values, impression, turnCount: state.turnCount + 1, updatedAt: now }, now);

  return {
    reply,
    values,
    debug: {
      note: appraisal.note ?? "",
      recalled: recalled.map((r) => r.memory.content),
      stored: storedNow,
      impression,
    },
  };
}
