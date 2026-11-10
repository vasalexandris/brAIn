import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countQuestions,
  extractSearchMarker,
  inventedScores,
  processTurn,
  pulse,
  resolveSearch,
} from "@/brain/pipeline";
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
    expect(extractSearchMarker("Χμ. [ψαξε Ειδήσεις: σεισμός Κρήτη] ").request).toEqual({ source: "web", query: "σεισμός Κρήτη" });
    expect(extractSearchMarker("Ας δω. [ΨΑΞΕ web: αποτελέσματα NBA]").request).toEqual({ source: "web", query: "αποτελέσματα NBA" });
    expect(extractSearchMarker("[ΨΑΞΕ wikipedia: κβάζαρ] και [ΨΑΞΕ wikipedia: πάλσαρ]")).toEqual({
      text: "και",
      request: { source: "wikipedia", query: "κβάζαρ" },
    });
    expect(extractSearchMarker("[ΨΑΞΕ wikipedia]").request).toBeNull();
    expect(extractSearchMarker("Τίποτα ιδιαίτερο [βλέπε παρακάτω].")).toEqual({ text: "Τίποτα ιδιαίτερο [βλέπε παρακάτω].", request: null });

    const u = await createUser(db, { email: "q@r.gr", name: "Μάρκος", passwordHash: "x" });
    let clock = new Date("2026-11-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    // «Ψάξε…» είναι ρητή εντολή: ψάχνει αμέσως, χωρίς κάρτα, και απαντά με δεύτερο μήνυμα.
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Κομήτης"], text: "## Κομήτης\nΜικρό παγωμένο σώμα." };
    };
    const r = await processTurn({ db, llm, lookup, now: at(1) }, u, "Ψάξε για τους κομήτες.");
    expect(r.reply).toBe("Θα ήθελα να το δω.");
    expect(r.search).toBeNull();
    expect(calls).toEqual(["wikipedia:τους κομήτες"]);
    expect(r.extra).toContain("Κομήτης");
    expect((await recentMessages(db, u.id, 3)).map((m) => m.content)).toEqual([
      "Ψάξε για τους κομήτες.",
      "Θα ήθελα να το δω.",
      r.extra,
    ]);
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

  it("ο αναστοχασμός βλέπει τι θυμάται ήδη, και ζητείται συμπύκνωση όταν η εικόνα εαυτού φουσκώσει", async () => {
    const u = await createUser(db, { email: "u@v.gr", name: "Ζωή", passwordHash: "x" });
    let clock = new Date("2026-11-05T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let reflectPrompt = "";
    let nextSelf = "";
    const spy: LlmProvider = {
      name: "spy",
      embed: llm.embed.bind(llm),
      generateText: async () => "Εντάξει.",
      generateJson: async (req) => {
        if (!req.prompt.includes("<απάντηση>")) return { perception: {}, impulses: {} };
        reflectPrompt = req.prompt;
        return { self_image: nextSelf, memories: [] };
      },
    };

    await processTurn({ db, llm, now: at(1) }, u, "Γεια σου, με λένε Ζωή.");
    nextSelf = "Μου αρέσει να μαθαίνω. ".repeat(40);
    const bloated = await processTurn({ db, llm: spy, now: at(1) }, u, "Με λένε Ζωή, θυμάσαι;");
    expect(reflectPrompt).toContain("- Τον συνομιλητή μου τον λένε Ζωή.");
    expect(reflectPrompt).not.toContain("έχει γίνει πολύ μεγάλη");
    // Ό,τι κι αν επιστρέψει το μοντέλο, αποθηκεύεται κομμένο σε τέλος πρότασης.
    expect(bloated.debug.selfImage.length).toBeLessThanOrEqual(500);
    expect(bloated.debug.selfImage.endsWith("μαθαίνω.")).toBe(true);

    nextSelf = "";
    await processTurn({ db, llm: spy, now: at(1) }, u, "Ωραία");
    expect(reflectPrompt).toContain("έχει γίνει πολύ μεγάλη");
  });

  it("το «ναι» γραμμένο στην κουβέντα μετρά ως έγκριση, και το «όχι» ως άρνηση", async () => {
    const u = await createUser(db, { email: "w@x.gr", name: "Πάνος", passwordHash: "x" });
    let clock = new Date("2026-11-06T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    let asked = "";
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Κβάζαρ"], text: "## Κβάζαρ\nΦωτεινός γαλαξιακός πυρήνας." };
    };
    const spy: LlmProvider = {
      name: "spy",
      embed: llm.embed.bind(llm),
      generateText: llm.generateText.bind(llm),
      generateJson: async (req) => {
        if (req.prompt.includes("<υλικό>")) asked = req.system;
        return llm.generateJson(req);
      },
    };

    const offer = await processTurn({ db, llm: spy, lookup, now: at(1) }, u, "Ξέρεις τι είναι τα κβάζαρ;");
    expect(offer.search).not.toBeNull();
    const yes = await processTurn({ db, llm: spy, lookup, now: at(1) }, u, "ναι");
    expect(calls).toEqual(["wikipedia:κβάζαρ"]);
    expect(yes.reply).toContain("Κβάζαρ");
    expect(yes.search).toBeNull();
    // Όταν διαβάζει, ξέρει τι της είχε ζητηθεί — όχι το σκέτο «ναι».
    expect(asked).toContain("«Ξέρεις τι είναι τα κβάζαρ;»");
    expect(asked).toContain("ΚΑΝΟΝΕΣ ΑΛΗΘΕΙΑΣ");
    expect((await recentMessages(db, u.id, 2)).map((m) => m.role)).toEqual(["user", "assistant"]);

    const again = await processTurn({ db, llm: spy, lookup, now: at(15) }, u, "Και τι είναι οι μαύρες τρύπες;");
    expect(again.search).not.toBeNull();
    const no = await processTurn({ db, llm: spy, lookup, now: at(1) }, u, "Όχι τώρα, άσ' το.");
    expect(calls).toHaveLength(1);
    expect(no.reply).not.toContain("Κβάζαρ");
    // Ένα «ναι» χωρίς εκκρεμή πρόταση είναι απλή κουβέντα.
    await processTurn({ db, llm: spy, lookup, now: at(1) }, u, "ναι");
    expect(calls).toHaveLength(1);
  });

  it("δεν περνά στον συνομιλητή σκορ που δεν υπάρχει στο υλικό που διάβασε", async () => {
    const material = "Οι Γουόριορς νίκησαν τους Σανς 118 - 109. Ο αγώνας έγινε στις 21:30.";
    expect(inventedScores("Νίκησαν 118-109.", material)).toEqual([]);
    expect(inventedScores("Νίκησαν 122-116 και οι Λέικερς έχασαν 104–110.", material)).toEqual(["122-116", "104–110"]);
    expect(inventedScores("Τα λέμε στις 11:52, σε 2-3 μέρες, το 2026.", material)).toEqual([]);

    const u = await createUser(db, { email: "y@z.gr", name: "Άρης", passwordHash: "x" });
    let clock = new Date("2026-11-07T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const lookup = async () => ({ titles: ["NBA"], text: "## NBA\nΆρθρο για τη διοργάνωση, χωρίς αποτελέσματα." });
    const liar: LlmProvider = {
      name: "liar",
      embed: llm.embed.bind(llm),
      generateText: llm.generateText.bind(llm),
      generateJson: async (req) =>
        req.prompt.includes("<υλικό>")
          ? {
              found: true,
              message: "Οι Γουόριορς νίκησαν τους Σανς με 122-116.",
              memories: [{ content: "Έμαθα ότι οι Γουόριορς νίκησαν 122-116.", importance: 60, valence: 20 }],
            }
          : llm.generateJson(req),
    };
    const offer = await processTurn({ db, llm: liar, lookup, now: at(1) }, u, "Τι είναι το NBA;");
    const read = await resolveSearch({ db, llm: liar, lookup, now: at(1) }, u, offer.search!.id, true);
    expect(read!.message).toContain("δεν βρήκα");
    expect(read!.message).not.toContain("122");
    expect(read!.stored).toEqual([]);
    expect((await listMemories(db, u.id)).some((m) => m.content.includes("122"))).toBe(false);
  });

  it("διαδίκτυο: χρησιμοποιεί την αναζήτηση του παρόχου, και αν αποτύχει πέφτει στις ειδήσεις", async () => {
    const u = await createUser(db, { email: "web@x.gr", name: "Ιωάννα", passwordHash: "x" });
    let clock = new Date("2026-11-08T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const queries: string[] = [];
    const withWeb: LlmProvider = {
      name: "web",
      embed: llm.embed.bind(llm),
      generateJson: llm.generateJson.bind(llm),
      generateText: async () => "Ας το δω.\n[ΨΑΞΕ web: αποτελέσματα NBA χθες]",
      searchWeb: async (q) => {
        queries.push(q);
        return { titles: ["nba.com"], text: "## Αποτελέσματα\nΓουόριορς - Σανς 118-109." };
      },
    };
    const offer = await processTurn({ db, llm: withWeb, now: at(1) }, u, "Ξέρεις τα χθεσινά αποτελέσματα του NBA;");
    expect(offer.reply).toBe("Ας το δω.");
    expect(offer.search).toMatchObject({ source: "web", sourceLabel: "διαδίκτυο", query: "αποτελέσματα NBA χθες" });
    const read = await resolveSearch({ db, llm: withWeb, now: at(1) }, u, offer.search!.id, true);
    expect(queries).toEqual(["αποτελέσματα NBA χθες"]);
    expect(read!.message).toContain("Αποτελέσματα");
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
