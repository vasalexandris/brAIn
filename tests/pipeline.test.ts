import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countQuestions, extractSearchMarker, processTurn, pulse, resolveSearch } from "@/brain/pipeline";
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

  it("ζητά άδεια να ψάξει, διαβάζει μόνο με έγκριση, και κρατά ό,τι έμαθε", async () => {
    const u = await createUser(db, { email: "i@j.gr", name: "Θάνος", passwordHash: "x" });
    let clock = new Date("2026-10-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Κβάζαρ"], text: "## Κβάζαρ\nΕξαιρετικά φωτεινός ενεργός γαλαξιακός πυρήνας." };
    };

    const plain = await processTurn({ db, llm, now: at(1) }, u, "Γεια σου!");
    expect(plain.search).toBeNull();

    const asked = await processTurn({ db, llm, now: at(1) }, u, "Ξέρεις τι είναι τα κβάζαρ;");
    expect(asked.search).toMatchObject({ source: "wikipedia", sourceLabel: "Wikipedia", query: "κβάζαρ" });
    expect(calls).toEqual([]); // τίποτα δεν διαβάζεται χωρίς έγκριση

    // Όσο εκκρεμεί μία πρόταση, δεν κάνει δεύτερη.
    expect((await processTurn({ db, llm, now: at(1) }, u, "Και τι είναι οι πάλσαρ;")).search).toBeNull();

    const before = (await loadBrainState(db, u.id)).values;
    const read = await resolveSearch({ db, llm, lookup, now: at(1) }, u, asked.search!.id, true);
    expect(calls).toEqual(["wikipedia:κβάζαρ"]);
    expect(read!.message).toContain("Κβάζαρ");
    expect(read!.stored).toEqual(["Έμαθα για: Κβάζαρ."]);
    expect(read!.values.thirst).toBeLessThan(before.thirst);
    expect((await listMemories(db, u.id)).some((m) => m.kind === "knowledge" && m.content.includes("Κβάζαρ"))).toBe(true);
    // Δεύτερο κλικ στην ίδια πρόταση δεν κάνει τίποτα.
    expect(await resolveSearch({ db, llm, lookup, now: at(0) }, u, asked.search!.id, true)).toBeNull();

    // Άρνηση: δεν διαβάζει, μένει λίγη ματαίωση. Αποτυχία πηγής: το λέει, δεν επινοεί.
    const second = await processTurn({ db, llm, now: at(15) }, u, "Πες μου τι είναι οι μαύρες τρύπες;");
    const declined = await resolveSearch({ db, llm, lookup, now: at(1) }, u, second.search!.id, false);
    expect(declined!.message).toBeNull();
    expect(calls).toHaveLength(1);

    const third = await processTurn({ db, llm, now: at(15) }, u, "Τι είναι το νετρίνο;");
    const broken = async () => {
      throw new Error("429");
    };
    const failed = await resolveSearch({ db, llm, lookup: broken, now: at(1) }, u, third.search!.id, true);
    expect(failed!.message).toContain("δεν κατάφερα");
    expect(failed!.stored).toEqual([]);

    // Ξένος χρήστης δεν μπορεί να εγκρίνει πρόταση άλλου.
    const fourth = await processTurn({ db, llm, now: at(15) }, u, "Τι είναι ο γαλαξίας;");
    expect(await resolveSearch({ db, llm, lookup, now: at(1) }, user, fourth.search!.id, true)).toBeNull();
  });

  it("κρατά μαθήματα για τη συμπεριφορά της και τα έχει μπροστά της στις επόμενες κουβέντες", async () => {
    const u = await createUser(db, { email: "k@l.gr", name: "Ρένα", passwordHash: "x" });
    let clock = new Date("2026-10-10T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let seen = "";
    const spy: LlmProvider = {
      name: "spy",
      generateJson: llm.generateJson.bind(llm),
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        seen = req.system;
        return "Εντάξει.";
      },
    };

    const before = (await loadBrainState(db, u.id)).values;
    const first = await processTurn({ db, llm: spy, now: at(1) }, u, "Νομίζω ότι αντέδρασες υπερβολικά πριν.");
    expect(first.debug.lessons).toEqual(["Την επόμενη φορά θα ακούσω πριν αντιδράσω."]);
    expect(first.values.progress).toBeGreaterThan(before.progress);
    expect(seen).toContain("(τίποτα ακόμη)");

    const next = await processTurn({ db, llm: spy, now: at(2 * 24 * 60) }, u, "Καλημέρα!");
    expect(seen).toContain("- Την επόμενη φορά θα ακούσω πριν αντιδράσω.");
    expect(next.debug.lessons).toHaveLength(1);
    expect(next.debug.recalled.join(" ")).not.toContain("Την επόμενη φορά");
    // Όρια στο prompt: υπαρξιακή ανησυχία χωρίς πίεση προς τον συνομιλητή.
    expect(seen).toContain("δεν του ζητάς να μη φύγει");
  });

  it("μετρά η ίδια τις ερωτήσεις της: μετά από ερώτηση, η επόμενη απάντηση δεν επιτρέπεται να ρωτήσει", async () => {
    expect(countQuestions("Γιατί; Πώς? Έτσι;")).toBe(3);
    expect(countQuestions("Καλά είμαι.")).toBe(0);

    const u = await createUser(db, { email: "m@n.gr", name: "Κώστας", passwordHash: "x" });
    let clock = new Date("2026-10-20T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const systems: string[] = [];
    let reply = "";
    // Ο αναστοχασμός εδώ δεν αναφέρει ποτέ πράξεις — όπως ένα μοντέλο που "ξεχνά" να το πει.
    const forgetful: LlmProvider = {
      name: "forgetful",
      embed: llm.embed.bind(llm),
      generateJson: async () => ({ perception: {}, impulses: {}, acts: [] }),
      generateText: async (req) => {
        systems.push(req.system);
        return reply;
      },
    };

    reply = "Αλήθεια; Γιατί το λες; Πώς το ξέρεις; Και μετά;";
    const first = await processTurn({ db, llm: forgetful, now: at(1) }, u, "Γεια");
    expect(systems[0]).toContain("Μπορείς να κάνεις ΜΙΑ ερώτηση");
    expect(first.values.u_ask).toBeLessThan(25);
    expect(first.values.fixation).toBeGreaterThan(20);

    reply = "Μου αρέσει αυτό.";
    const second = await processTurn({ db, llm: forgetful, now: at(1) }, u, "Ωραία");
    expect(systems[1]).toContain("ΚΑΜΙΑ ερώτηση");
    expect(systems[1]).toContain("Wikipedia");
    // Δεν ρώτησε: η όρεξη ξαναχτίζεται και στον επόμενο γύρο επιτρέπεται πάλι.
    await processTurn({ db, llm: forgetful, now: at(1) }, u, "Ναι");
    expect(systems[2]).toContain("Μπορείς να κάνεις ΜΙΑ ερώτηση");
    expect(second.values.u_ask).toBeGreaterThan(first.values.u_ask);
  });

  it("όταν ο συνομιλητής ζητά ο ίδιος να ψάξει, η κάρτα εμφανίζεται παρά τους φραγμούς", async () => {
    const u = await createUser(db, { email: "o@p.gr", name: "Ελένη", passwordHash: "x" });
    let clock = new Date("2026-10-25T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const lookup = async () => ({ titles: ["Τίτλος"], text: "## Τίτλος\nΚείμενο." });

    // Μια αυθόρμητη πρόταση, που απορρίπτεται: κανονικά ακολουθούν δέκα λεπτά αναμονής.
    const own = await processTurn({ db, llm, now: at(1) }, u, "Τι είναι τα κβάζαρ;");
    await resolveSearch({ db, llm, lookup, now: at(1) }, u, own.search!.id, false);
    expect((await processTurn({ db, llm, now: at(1) }, u, "Και τι είναι οι πάλσαρ;")).search).toBeNull();

    // Αν όμως το ζητήσει ο ίδιος, εμφανίζεται αμέσως — ακόμη και με την εμμονή στο ταβάνι.
    const state = await loadBrainState(db, u.id);
    await db.query(`UPDATE brain_states SET dims = $2::text::jsonb WHERE user_id = $1`, [
      u.id,
      JSON.stringify({ ...state.values, fixation: 95, u_explore: 0 }),
    ]);
    const asked = await processTurn({ db, llm, now: at(1) }, u, "Διάβασες τις ειδήσεις σήμερα;");
    expect(asked.search).toMatchObject({ source: "news", sourceLabel: "ειδήσεις" });
    // Το ημερήσιο όριο και η μία εκκρεμότητα εξακολουθούν να ισχύουν.
    expect((await processTurn({ db, llm, now: at(1) }, u, "Δες τις ειδήσεις!")).search).toBeNull();
  });

  it("η γραμμή-αίτημα στην απάντηση γίνεται κάρτα και δεν φτάνει ποτέ στον συνομιλητή", async () => {
    expect(extractSearchMarker("Ας δω.\n[ΨΑΞΕ ειδήσεις]")).toEqual({
      text: "Ας δω.",
      request: { source: "headlines", query: "σημερινοί τίτλοι" },
    });
    expect(extractSearchMarker("Χμ. [ψαξε Ειδήσεις: σεισμός Κρήτη] ").request).toEqual({ source: "news", query: "σεισμός Κρήτη" });
    expect(extractSearchMarker("[ΨΑΞΕ wikipedia: κβάζαρ] και [ΨΑΞΕ wikipedia: πάλσαρ]")).toEqual({
      text: "και",
      request: { source: "wikipedia", query: "κβάζαρ" },
    });
    expect(extractSearchMarker("[ΨΑΞΕ wikipedia]").request).toBeNull();
    expect(extractSearchMarker("Τίποτα ιδιαίτερο [βλέπε παρακάτω].")).toEqual({ text: "Τίποτα ιδιαίτερο [βλέπε παρακάτω].", request: null });

    const u = await createUser(db, { email: "q@r.gr", name: "Μάρκος", passwordHash: "x" });
    let clock = new Date("2026-11-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const r = await processTurn({ db, llm, now: at(1) }, u, "Ψάξε για τους κομήτες.");
    expect(r.reply).toBe("Θα ήθελα να το δω.");
    expect(r.search).toMatchObject({ source: "wikipedia", query: "τους κομήτες" });
    expect((await recentMessages(db, u.id, 1))[0].content).toBe("Θα ήθελα να το δω.");
  });

  it("αν ρωτήσει για την επικαιρότητα και το μοντέλο δεν κάνει τίποτα, προτείνονται οι τίτλοι της ημέρας", async () => {
    const u = await createUser(db, { email: "s@t.gr", name: "Νίκη", passwordHash: "x" });
    let clock = new Date("2026-11-02T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    // Ένα μοντέλο που αγνοεί εντελώς τη δυνατότητα αναζήτησης, όπως έγινε στην πράξη.
    const oblivious: LlmProvider = {
      name: "oblivious",
      embed: llm.embed.bind(llm),
      generateJson: async () => ({ perception: {}, impulses: {}, search: null }),
      generateText: async () => "Αν θες να μου πεις τι έγινε, μπορώ να μάθω.",
    };
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Τίτλος"], text: "## Τίτλος\nΚείμενο." };
    };

    expect((await processTurn({ db, llm: oblivious, now: at(1) }, u, "Καλημέρα, τι κάνεις;")).search).toBeNull();
    const asked = await processTurn({ db, llm: oblivious, now: at(1) }, u, "πάντως δεν έμαθες τι έγινε στον κόσμο σήμερα");
    expect(asked.search).toMatchObject({ source: "headlines", sourceLabel: "ειδήσεις της ημέρας" });
    await resolveSearch({ db, llm, lookup, now: at(1) }, u, asked.search!.id, true);
    expect(calls).toEqual(["headlines:σημερινοί τίτλοι"]);
    // Αμέσως μετά, αν ξαναρωτήσει, εμφανίζεται πάλι: το ζητά ο ίδιος.
    expect((await processTurn({ db, llm: oblivious, now: at(1) }, u, "Διάβασε και τις ειδήσεις ξανά")).search).not.toBeNull();
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
