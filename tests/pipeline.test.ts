import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processTurn, pulse } from "@/brain/pipeline";
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

  it("παίρνει τον λόγο μόνη της όταν η σιωπή κρατήσει, αλλά δεν επιμένει για πάντα", async () => {
    const fresh = await createUser(db, { email: "c@d.gr", name: "Άννα", passwordHash: "x" });
    let clock = new Date("2026-07-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));

    // Δεν μιλά πρώτη σε κάποιον που δεν της έχει γράψει ποτέ.
    expect((await pulse({ db, llm, now: at(0) }, fresh)).nextInSec).toBeNull();

    await processTurn({ db, llm, now: at(1) }, fresh, "Γεια σου!");
    const soon = await pulse({ db, llm, now: at(0.5) }, fresh);
    expect(soon.message).toBeNull();
    expect(soon.nextInSec).toBeGreaterThan(30);

    const first = await pulse({ db, llm, now: at(soon.nextInSec! / 60) }, fresh);
    expect(first.message).toContain("σκεφτόμουν");
    expect((await pulse({ db, llm, now: at(1) }, fresh)).message).toBeNull();
    const second = await pulse({ db, llm, now: at(first.nextInSec! / 60) }, fresh);
    expect(second.message).not.toBeNull();
    // Δύο αναπάντητα: σωπαίνει, όσος καιρός κι αν περάσει.
    expect(second.nextInSec).toBeNull();
    expect((await pulse({ db, llm, now: at(60) }, fresh)).message).toBeNull();
    expect((await pulse({ db, llm, now: at(5 * 24 * 60) }, fresh)).nextInSec).toBeNull();

    const msgs = await recentMessages(db, fresh.id, 10);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);

    // Μόλις απαντήσει, ο κύκλος ξαναρχίζει — και θυμάται ότι έλειψε.
    const back = await processTurn({ db, llm, now: at(3 * 24 * 60) }, fresh, "Συγγνώμη που χάθηκα.");
    expect(back.values.presence).toBeGreaterThan(40);
    expect((await pulse({ db, llm, now: at(0.5) }, fresh)).nextInSec).toBeLessThan(3600);
  });

  it("ημερήσια όρια: το πολύ έξι πρωτοβουλίες και πεπερασμένα μηνύματα ανά 24 ώρες", async () => {
    const chatty = await createUser(db, { email: "e@f.gr", name: "Λία", passwordHash: "x" });
    let clock = new Date("2026-08-01T08:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      await processTurn({ db, llm, now: at(1) }, chatty, "Γεια!");
      if ((await pulse({ db, llm, now: at(30) }, chatty)).message) sent++;
    }
    expect(sent).toBe(6);

    const { DAILY_MESSAGE_LIMIT, DailyLimitError } = await import("@/brain/pipeline");
    for (let i = 10; i < DAILY_MESSAGE_LIMIT; i++) {
      await db.query(`INSERT INTO messages (id, user_id, role, content, created_at) VALUES ($1, $2, 'user', 'x', $3)`, [
        `bulk-${i}`,
        chatty.id,
        at(0).toISOString(),
      ]);
    }
    await expect(processTurn({ db, llm, now: at(1) }, chatty, "Κι άλλο")).rejects.toBeInstanceOf(DailyLimitError);
    await expect(processTurn({ db, llm, now: at(25 * 60) }, chatty, "Καλημέρα")).resolves.toBeTruthy();
  });

  it("βάζει δικούς της στόχους, τους κρατά, και τους κλείνει όταν πάρει την απάντηση", async () => {
    const u = await createUser(db, { email: "g@h.gr", name: "Ίρις", passwordHash: "x" });
    let clock = new Date("2026-09-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));

    const first = await processTurn({ db, llm, now: at(1) }, u, "Αγαπώ την αστρονομία.");
    expect(first.debug.goals).toEqual(["Θέλω να μάθω γιατί αγαπά αστρονομία."]);
    expect(first.debug.selfImage).toBe("");

    // Τρεις μέρες μετά ο στόχος είναι ακόμη εκεί, και δεν μπερδεύεται με τις απλές αναμνήσεις.
    const later = await processTurn({ db, llm, now: at(3 * 24 * 60) }, u, "Καλημέρα!");
    expect(later.debug.goals).toHaveLength(1);
    expect(later.debug.recalled.join(" ")).not.toContain("Θέλω να μάθω");

    const done = await processTurn({ db, llm, now: at(1) }, u, "Επειδή με κάνει να νιώθω μικρός.");
    expect(done.debug.goals).toEqual([]);
    expect(done.debug.selfImage).toContain("Μου αρέσει");
    expect((await listMemories(db, u.id)).filter((m) => m.kind === "goal")).toHaveLength(0);
    expect((await loadBrainState(db, u.id)).selfImage).toContain("Μου αρέσει");
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
