import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processTurn } from "@/brain/pipeline";
import { createPgliteDb, type Db } from "@/db";
import { createUser, listMemories, loadBrainState, recentMessages } from "@/db/repo";
import { MockProvider } from "@/llm/mock";
import type { LlmProvider } from "@/llm/types";

describe("ένας γύρος συζήτησης (ενσωματωμένη βάση + δοκιμαστικό μοντέλο)", () => {
  let db: Db;
  const llm = new MockProvider();
  let user: { id: string; name: string };
  let t = new Date("2026-06-01T10:00:00Z").getTime();
  const tick = (min = 1) => new Date((t += min * 60000));

  beforeAll(async () => {
    db = await createPgliteDb();
    user = await createUser(db, { email: "a@b.gr", name: "Νίκος", passwordHash: "x" });
  });
  afterAll(() => db.close());

  it("κρατά στη μνήμη ό,τι αξίζει και το ανακαλεί αργότερα", async () => {
    const first = await processTurn({ db, llm, now: tick() }, user, "Γεια σου, με λένε Νίκος.");
    expect(first.debug.stored).toHaveLength(1);
    const second = await processTurn({ db, llm, now: tick() }, user, "Τι καιρό κάνει;");
    expect(second.debug.stored).toHaveLength(0);
    expect(second.debug.recalled.join(" ")).toContain("Νίκος");
    expect(await listMemories(db, user.id)).toHaveLength(1);
  });

  it("οι προσβολές το θυμώνουν, αλλάζουν το ύφος του, και η συγγνώμη το ηρεμεί", async () => {
    const before = (await loadBrainState(db, user.id)).values;
    await processTurn({ db, llm, now: tick() }, user, "Είσαι εντελώς ηλίθια.");
    const angry = await processTurn({ db, llm, now: tick() }, user, "Άχρηστη και χαζή.");
    expect(angry.values.anger).toBeGreaterThan(before.anger + 15);
    expect(angry.values.liking).toBeLessThan(before.liking);
    expect(angry.reply).toMatch(/Σταμάτα|ευγενικό/);

    const calmer = await processTurn({ db, llm, now: tick() }, user, "Συγγνώμη, δεν το εννοούσα.");
    expect(calmer.values.anger).toBeLessThan(angry.values.anger);
    // Η σχέση δεν επανέρχεται με μία συγγνώμη.
    expect(calmer.values.liking).toBeLessThan(before.liking);

    const stored = await loadBrainState(db, user.id);
    expect(stored.turnCount).toBe(5);
    expect(stored.values.anger).toBe(calmer.values.anger);
    const msgs = await recentMessages(db, user.id, 4);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("αντέχει όταν η αντίληψη ή ο αναστοχασμός επιστρέψουν σκουπίδια", async () => {
    const broken: LlmProvider = {
      name: "broken",
      generateText: async () => "Εντάξει.",
      generateJson: async () => ({ perception: "όχι", impulses: { anger: "πολύ", nope: 5 }, memories: [{ content: 7 }] }),
      embed: async () => {
        throw new Error("down");
      },
    };
    const r = await processTurn({ db, llm: broken, now: tick() }, user, "Καλημέρα");
    expect(r.reply).toBe("Εντάξει.");
    expect(Number.isFinite(r.values.anger)).toBe(true);
  });

  it("αν αποτύχει η απόκριση, δεν αποθηκεύεται τίποτα", async () => {
    const dead: LlmProvider = { ...llm, name: "dead", generateJson: llm.generateJson.bind(llm), embed: llm.embed.bind(llm), generateText: async () => { throw new Error("x"); } };
    const count = (await loadBrainState(db, user.id)).turnCount;
    await expect(processTurn({ db, llm: dead, now: tick() }, user, "Γεια")).rejects.toThrow();
    expect((await loadBrainState(db, user.id)).turnCount).toBe(count);
  });
});
