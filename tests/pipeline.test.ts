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
import { createUser, listMemories, loadBrainState, recentMessages, setAutoNews } from "@/db/repo";
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
    expect(asked.search).toMatchObject({ source: "headlines", sourceLabel: "ειδήσεις της ημέρας" });
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
    expect(inventedScores("Θα πάρει 10-15 λεπτά, ίσως 20-30. Πριν από 50-60 χρόνια.", material)).toEqual([]);

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

  it("δεν λέει ποτέ «να το ψάξω;» χωρίς κάρτα, και καταλαβαίνει «ναι», «ψάξτο», «δεν ψάχνεις»", async () => {
    const u = await createUser(db, { email: "loop@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-09T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["NBA"], text: "## NBA\nΓουόριορς - Σανς 118-109." };
    };
    // Όπως στην πράξη: το μοντέλο απαντά μόνο με τη γραμμή-αίτημα, και ο αναστοχασμός δεν λέει τίποτα.
    let text = "Γεια.";
    const stuck: LlmProvider = {
      name: "stuck",
      embed: llm.embed.bind(llm),
      generateText: async () => text,
      generateJson: async (req) =>
        req.prompt.includes("<υλικό>") ? { message: "Βρήκα: Γουόριορς - Σανς 118-109.", memories: [] } : { perception: {}, impulses: {} },
    };
    const maxFixation = async () => {
      const st = await loadBrainState(db, u.id);
      await db.query(`UPDATE brain_states SET dims = $2::text::jsonb WHERE user_id = $1`, [
        u.id,
        JSON.stringify({ ...st.values, fixation: 100, u_explore: 0 }),
      ]);
    };

    // Ρωτά κάτι χωρίς να πει «ψάξε»: προσφέρεται, και η κάρτα υπάρχει — ακόμη και με εμμονή στο 100.
    await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "Γεια σου");
    await maxFixation();
    text = "[ΨΑΞΕ web: αποτελέσματα NBA χθες]";
    const offer = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "Ξέρεις τα χθεσινά αποτελέσματα του NBA;");
    expect(offer.reply).toBe("Να το ψάξω;");
    expect(offer.search).not.toBeNull();
    expect(calls).toEqual([]);

    // «ναι» με εκκρεμή κάρτα: ψάχνει.
    const yes = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "ναι");
    expect(yes.reply).toContain("118-109");
    expect(calls).toHaveLength(1);

    // Παράπονο ότι δεν ψάχνει, και σκέτο «ψάξτο»: είναι εντολές, ψάχνει αμέσως.
    await maxFixation();
    const complaint = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "δεν βλέπω αποτελέσματα, μάλλον δεν ψάχνεις");
    expect(complaint.reply).toBe("Το ψάχνω.");
    expect(complaint.extra).toContain("118-109");
    expect(complaint.search).toBeNull();
    const short = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "Ναι ψάξτο!");
    expect(short.extra).toContain("118-109");
    expect(calls).toHaveLength(3);

    // Λέει «ψάχνω τώρα» χωρίς γραμμή-αίτημα: και πάλι γίνεται κάρτα, με ερώτημα τα λόγια του.
    text = "Λοιπόν, ψάχνω τώρα για τα αποτελέσματα.";
    const claims = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "Ποια ομάδα κέρδισε χθες το βράδυ στο Σαν Φρανσίσκο;");
    expect(claims.search).toMatchObject({ source: "web", query: "Ποια ομάδα κέρδισε χθες το βράδυ στο Σαν Φρανσίσκο;" });
    // «ναι» στη δική της προσφορά, ακόμη κι αν η κάρτα έχει χαθεί.
    await db.query(`UPDATE searches SET status = 'declined' WHERE id = $1`, [claims.search!.id]);
    text = "[ΨΑΞΕ web: νικητής Σαν Φρανσίσκο]";
    const agreed = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "ναι");
    expect(agreed.extra).toContain("118-109");

    // Αν πει ρητά να μην ψάξει, δεν ψάχνει και δεν βγαίνει κάρτα από τα λόγια του.
    text = "Εντάξει.";
    const before = calls.length;
    const no = await processTurn({ db, llm: stuck, lookup, now: at(1) }, u, "Όχι, μην ψάξεις τίποτα άλλο σήμερα.");
    expect(no.search).toBeNull();
    expect(no.extra).toBeNull();
    expect(calls).toHaveLength(before);
  });

  it("ό,τι διάβασε μένει μπροστά της για τις επόμενες ερωτήσεις, και δεν περνά σκορ που δεν έχει δει", async () => {
    const u = await createUser(db, { email: "mat@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-10T20:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const lookup = async () => ({ titles: ["NBA"], text: "## 9 Νοεμβρίου\nΛέικερς - Χοκς 124-114\nΠέλικανς - Ουόριορς 87-138" });
    let text = "Γεια.";
    let system = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return text;
      },
      generateJson: async (req) =>
        req.prompt.includes("<υλικό>") ? { message: "Βρήκα τα αποτελέσματα της 9ης Νοεμβρίου.", memories: [] } : { perception: {}, impulses: {} },
    };

    text = "Ας δω.";
    const first = await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Ψάξε τα χθεσινά αποτελέσματα του NBA");
    expect(first.extra).toContain("9ης Νοεμβρίου");

    // Σκορ που υπάρχουν στο υλικό περνούν· το υλικό είναι μέσα στο prompt.
    text = "Λέικερς - Χοκς 124-114 και Πέλικανς - Ουόριορς 87-138.";
    const fromMaterial = await processTurn({ db, llm: model, lookup, now: at(2) }, u, "δεν μπορείς να μου δώσεις σκορ;");
    expect(system).toContain("ΤΙ ΔΙΑΒΑΣΕΣ ΠΡΟΣΦΑΤΑ");
    expect(system).toContain("Πέλικανς - Ουόριορς 87-138");
    expect(fromMaterial.reply).toContain("124-114");

    // Σκορ για μέρα που δεν υπάρχει στο υλικό: δεν φτάνουν στον συνομιλητή, και προσφέρεται να ψάξει.
    text = "10 Νοεμβρίου: Λέικερς - Κινγκς 128-115, Σανς - Νάγκετς 110-109.";
    const invented = await processTurn({ db, llm: model, lookup, now: at(2) }, u, "και της 10ης;");
    expect(invented.reply).not.toContain("128");
    expect(invented.reply).toContain("Δεν έχω μπροστά μου");
    expect(invented.search).toMatchObject({ source: "web" });
    await resolveSearch({ db, llm: model, lookup, now: at(1) }, u, invented.search!.id, false);

    // Ένα σκορ που ανέφερε ο ίδιος ο συνομιλητής μπορεί φυσικά να το επαναλάβει.
    text = "Α, 101-99 λες. Κοντινό ματς.";
    expect((await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Ο Ολυμπιακός κέρδισε 101-99!")).reply).toContain("101-99");

    // Μετά από μία ώρα το υλικό δεν είναι πια μπροστά της.
    text = "Καλά είμαι.";
    await processTurn({ db, llm: model, lookup, now: at(60) }, u, "Τι κάνεις τώρα που πέρασε η ώρα");
    expect(system).not.toContain("ΤΙ ΔΙΑΒΑΣΕΣ ΠΡΟΣΦΑΤΑ");
  });

  it("η γνώση αρχειοθετείται σε τρία επίπεδα: με τον καιρό μένει μια εικόνα, και με την επιμονή ξαναβρίσκεται", async () => {
    const u = await createUser(db, { email: "deep@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-06-01T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const lookup = async () => ({ titles: ["Κβάζαρ"], text: "## Κβάζαρ\nΤο 3C 273 απέχει 2,4 δισεκατομμύρια έτη φωτός." });
    let system = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return "Εντάξει.";
      },
      generateJson: async (req) =>
        req.prompt.includes("<υλικό>")
          ? {
              found: true,
              message: "Διάβασα για τα κβάζαρ.",
              memories: [
                {
                  topic: "Αστρονομία",
                  gist: "κάτι για τα κβάζαρ",
                  content: "Έμαθα ότι τα κβάζαρ είναι φωτεινοί γαλαξιακοί πυρήνες.",
                  detail: "Το 3C 273 απέχει 2,4 δισεκατομμύρια έτη φωτός.",
                  importance: 50,
                  valence: 30,
                },
              ],
            }
          : { perception: {}, impulses: {} },
    };
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Γεια σου!");
    const offer = await processTurn({ db, llm, lookup, now: at(1) }, u, "Ξέρεις τι είναι τα κβάζαρ;");
    await resolveSearch({ db, llm: model, lookup, now: at(1) }, u, offer.search!.id, true);
    const stored = (await listMemories(db, u.id)).find((m) => m.topic === "αστρονομία")!;
    expect(stored).toMatchObject({ gist: "κάτι για τα κβάζαρ", detail: "Το 3C 273 απέχει 2,4 δισεκατομμύρια έτη φωτός." });

    // Την επόμενη μέρα: φρέσκια, με όλες τις λεπτομέρειες, και το ράφι φαίνεται στο «τι ξέρεις ότι ξέρεις».
    await processTurn({ db, llm: model, lookup, now: at(20 * 60) }, u, "Πες μου για τα κβάζαρ, τους γαλαξιακούς πυρήνες");
    expect(system).toContain("αστρονομία (1, φρέσκο)");
    expect(system).toContain("Λεπτομέρειες: Το 3C 273");

    // Δύο μήνες μετά, χωρίς να έχει ξαναγίνει κουβέντα: μόνο η εικόνα. Οι λεπτομέρειες δεν φαίνονται.
    const faint = await processTurn({ db, llm: model, lookup, now: at(60 * 24 * 60) }, u, "Θυμάσαι τα κβάζαρ, τους γαλαξιακούς πυρήνες;");
    expect(system).toContain("[αχνή] κάτι για τα κβάζαρ");
    expect(system).not.toContain("3C 273");
    expect(faint.debug.recalled).toContain("[αχνή] κάτι για τα κβάζαρ");

    // Η κουβέντα επιμένει: πρώτα επιστρέφουν τα βασικά, μετά και οι λεπτομέρειες.
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Τα κβάζαρ, οι φωτεινοί γαλαξιακοί πυρήνες. Σκέψου.");
    expect(system).toContain("Έμαθα ότι τα κβάζαρ είναι φωτεινοί γαλαξιακοί πυρήνες.");
    expect(system).not.toContain("3C 273");
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Κβάζαρ, γαλαξιακοί πυρήνες. Τι άλλο θυμάσαι;");
    expect(system).toContain("Λεπτομέρειες: Το 3C 273");
  });

  it("σκέφτεται τι θα ψάξει αντί να ψάχνει τα λόγια του αυτούσια, και ξέρει πότε δεν υπάρχει κάτι να ψαχτεί", async () => {
    const u = await createUser(db, { email: "plan@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-11T08:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let text = "Θα μπορούσα να ψάχνω τις ειδήσεις κάθε μέρα, τι λες;";
    let plan: unknown = { source: "none", query: "" };
    let planPrompt = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async () => text,
      generateJson: async (req) => {
        if (req.prompt.includes("<σχέδιο>")) {
          planPrompt = req.prompt;
          return plan;
        }
        return { perception: {}, impulses: {} };
      },
    };
    const long = "εγώ θα ήθελα ανάλογα με τα ενδιαφέροντά σου να θες να μαθαίνεις, να μπορώ να κάνω συζήτηση μαζί σου γι' αυτό";

    // Το μοντέλο κρίνει ότι δεν υπάρχει κάτι συγκεκριμένο: καμία κάρτα, κανένα σκουπίδι-ερώτημα.
    await processTurn({ db, llm: model, now: at(1) }, u, "Γεια");
    const none = await processTurn({ db, llm: model, now: at(1) }, u, long);
    expect(none.search).toBeNull();
    expect(planPrompt).toContain("Θα μπορούσα να ψάχνω τις ειδήσεις κάθε μέρα");

    // Κρίνει ότι θέλει τους τίτλους της ημέρας.
    plan = { source: "headlines", query: "ό,τι να 'ναι" };
    expect((await processTurn({ db, llm: model, now: at(15) }, u, long)).search).toMatchObject({ source: "headlines" });
    await db.query(`UPDATE searches SET status = 'declined' WHERE user_id = $1`, [u.id]);

    // Διατυπώνει σύντομο ερώτημα, όχι ολόκληρη την πρόταση.
    plan = { source: "web", query: "σεισμός Κρήτη σήμερα" };
    text = "Να το ψάξω αυτό.";
    const q = await processTurn({ db, llm: model, now: at(15) }, u, "Άκουσα κάτι για έναν σεισμό στην Κρήτη σήμερα το πρωί, δεν ξέρω λεπτομέρειες");
    expect(q.search).toMatchObject({ source: "web", query: "σεισμός Κρήτη σήμερα" });
  });

  it("αν δεν βρει, σκέφτεται άλλο ερώτημα και ξαναδοκιμάζει μία φορά· αν πετύχει, κρατά το μάθημα", async () => {
    const u = await createUser(db, { email: "retry@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-11T09:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return query.includes("Ολυμπιακός")
        ? { titles: ["Αγώνας"], text: "## Αγώνας\nΟλυμπιακός - Ρεάλ 88-79." }
        : { titles: ["Μποτάκια"], text: "## Γυναικεία μποτάκια\nΠροσφορές." };
    };
    let retry: unknown = { source: "web", query: "Ολυμπιακός Ρεάλ αποτέλεσμα" };
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async () => "[ΨΑΞΕ web: μπάσκετ χθες]",
      generateJson: async (req) => {
        if (!req.prompt.includes("<υλικό>")) return { perception: {}, impulses: {} };
        if (req.prompt.includes("μποτάκια")) return { found: false, message: "Δεν βρήκα κάτι σχετικό.", retry, memories: [] };
        return { found: true, message: "Ολυμπιακός - Ρεάλ 88-79.", memories: [] };
      },
    };
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Γεια");
    await db.query(`UPDATE searches SET status = 'declined' WHERE user_id = $1`, [u.id]);

    const done = await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Ψάξε πώς πήγε χθες το μπάσκετ");
    expect(calls).toEqual(["web:μπάσκετ χθες", "web:Ολυμπιακός Ρεάλ αποτέλεσμα"]);
    expect(done.extra).toBe("Ολυμπιακός - Ρεάλ 88-79.");
    const lesson = (await listMemories(db, u.id)).find((m) => m.kind === "lesson");
    expect(lesson?.content).toContain("«μπάσκετ χθες»");
    expect(lesson?.content).toContain("«Ολυμπιακός Ρεάλ αποτέλεσμα»");
    expect(lesson?.topic).toBe("αναζήτηση");

    // Αν και η δεύτερη αποτύχει, το λέει· δεν δοκιμάζει τρίτη.
    calls.length = 0;
    retry = { source: "wikipedia", query: "άλλα μποτάκια" };
    const failed = await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Ψάξε ξανά κάτι άλλο για το μπάσκετ");
    expect(calls).toHaveLength(2);
    expect(failed.extra).toBe("Δεν βρήκα κάτι σχετικό.");
    // Ίδιο ερώτημα στην ίδια πηγή δεν είναι "άλλη προσπάθεια".
    calls.length = 0;
    retry = { source: "web", query: "μπάσκετ χθες" };
    await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Ψάξε το πάλι");
    expect(calls).toHaveLength(1);
  });

  it("συνδυάζει γνώσεις σε υπόθεση, που μένει χωριστά από τη γνώση ώσπου να επαληθευτεί απ' έξω", async () => {
    const u = await createUser(db, { email: "hyp@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-12T09:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let system = "";
    let reflectPrompt = "";
    let reflection: Record<string, unknown> = {};
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return "Εντάξει.";
      },
      generateJson: async (req) => {
        if (req.prompt.includes("<υλικό>")) return reading;
        if (!req.prompt.includes("<απάντηση>")) return { perception: {}, impulses: {} };
        reflectPrompt = req.prompt;
        return reflection;
      },
    };
    let reading: Record<string, unknown> = {};
    const hyp = (content: string, certainty: number) => ({
      kind: "hypothesis",
      topic: "ο συνομιλητής",
      gist: "ίσως δουλεύει βράδυ",
      content,
      detail: "Μου γράφει πάντα μετά τα μεσάνυχτα και λέει ότι είναι κουρασμένος.",
      certainty,
      importance: 60,
      valence: 0,
    });

    // Γεννιέται μία υπόθεση (όχι δύο), και ποτέ πιο σίγουρη από 60%.
    reflection = { memories: [hyp("Υποθέτω ότι ο Βασίλης δουλεύει βραδινή βάρδια.", 95), hyp("Και δεύτερη υπόθεση.", 50)] };
    const born = await processTurn({ db, llm: model, now: at(1) }, u, "Πάλι ξενύχτησα, είμαι πτώμα.");
    expect(born.debug.hypotheses).toEqual(["Υποθέτω ότι ο Βασίλης δουλεύει βραδινή βάρδια."]);
    const stored = (await listMemories(db, u.id)).filter((m) => m.kind === "hypothesis");
    expect(stored).toHaveLength(1);
    expect(stored[0].certainty).toBeCloseTo(0.6);

    // Στο επόμενο μήνυμα την έχει μπροστά της ως υπόθεση, όχι ανάμεσα σε όσα «ξέρει».
    reflection = {};
    const next = await processTurn({ db, llm: model, now: at(1) }, u, "Τι λες για τη δουλειά μου και τη βραδινή βάρδια;");
    expect(system).toContain("- (βεβαιότητα 60%) Υποθέτω ότι ο Βασίλης δουλεύει βραδινή βάρδια.");
    expect(next.debug.recalled.join(" ")).not.toContain("βραδινή βάρδια");
    expect(reflectPrompt).toContain("1. Υποθέτω ότι ο Βασίλης δουλεύει βραδινή βάρδια.");

    // Ετυμηγορία χωρίς τεκμήριο αγνοείται: δεν επιβεβαιώνει τον εαυτό της.
    reflection = { verdicts: [{ n: 1, verdict: "confirmed", evidence: "" }] };
    await processTurn({ db, llm: model, now: at(1) }, u, "Χμ.");
    expect((await listMemories(db, u.id)).filter((m) => m.kind === "hypothesis")).toHaveLength(1);

    // Ο συνομιλητής τη διαψεύδει: γίνεται γνώση του λάθους της, με το τεκμήριο στις λεπτομέρειες.
    reflection = { verdicts: [{ n: 1, verdict: "refuted", evidence: "Είπε ότι δουλεύει πρωί και απλώς δεν κοιμάται καλά." }] };
    const before = (await loadBrainState(db, u.id)).values;
    const refuted = await processTurn({ db, llm: model, now: at(1) }, u, "Όχι, πρωί δουλεύω. Απλώς δεν κοιμάμαι καλά.");
    const all = await listMemories(db, u.id);
    expect(all.filter((m) => m.kind === "hypothesis")).toHaveLength(0);
    const lesson = all.find((m) => m.content.includes("Αποδείχθηκε λάθος"))!;
    expect(lesson).toMatchObject({ kind: "knowledge", certainty: 1 });
    expect(lesson.detail).toContain("Διαψεύστηκε (από τον συνομιλητή): Είπε ότι δουλεύει πρωί");
    expect(refuted.debug.hypotheses).toEqual([]);
    expect(refuted.values.progress).toBeGreaterThan(before.progress);

    // Νέα υπόθεση, που αυτή τη φορά επιβεβαιώνεται από υλικό αναζήτησης.
    reflection = { memories: [hyp("Υποθέτω ότι η αϋπνία σχετίζεται με το φως της οθόνης.", 40)] };
    await processTurn({ db, llm: model, now: at(1) }, u, "Κοιτάζω το κινητό ως αργά.");
    reflection = {};
    reading = {
      found: true,
      message: "Διάβασα ότι το μπλε φως καθυστερεί τον ύπνο.",
      verdicts: [{ n: 1, verdict: "confirmed", evidence: "Το μπλε φως των οθονών καταστέλλει τη μελατονίνη." }],
      memories: [],
    };
    const lookup = async () => ({ titles: ["Ύπνος"], text: "## Ύπνος\nΤο μπλε φως των οθονών καταστέλλει τη μελατονίνη." });
    const read = await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Ψάξε αν το φως της οθόνης πειράζει τον ύπνο");
    expect(read.extra).toContain("μπλε φως");
    const confirmed = (await listMemories(db, u.id)).find((m) => m.content.includes("φως της οθόνης"))!;
    expect(confirmed).toMatchObject({ kind: "knowledge", certainty: 1, content: "Υποθέτω ότι η αϋπνία σχετίζεται με το φως της οθόνης." });
    expect(confirmed.detail).toContain("Επιβεβαιώθηκε (από αναζήτηση");
    expect(read.debug.stored.join(" ")).toContain("Επιβεβαίωσα:");
  });

  it("ανοίγει ιστοσελίδα που της έδωσε ο συνομιλητής ή που είδε σε υλικό, ποτέ διεύθυνση που επινόησε", async () => {
    const u = await createUser(db, { email: "page@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-12T12:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return source === "headlines"
        ? { titles: ["Τίτλος"], text: "## Τίτλος\nΠερίληψη.\nΣύνδεσμος: https://www.ertnews.gr/arthro-1/" }
        : { titles: ["Άρθρο"], text: "## Άρθρο\nΤο πλήρες κείμενο του άρθρου." };
    };
    let text = "Ας το δω.";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async () => text,
      generateJson: async (req) =>
        req.prompt.includes("<υλικό>") ? { found: true, message: "Το διάβασα.", memories: [] } : { perception: {}, impulses: {} },
    };

    // Ο συνομιλητής δίνει διεύθυνση και ζητά να τη δει: διαβάζεται αμέσως.
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Γεια");
    const given = await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Διάβασε αυτό: https://example.com/keimeno.");
    expect(calls).toEqual(["page:https://example.com/keimeno"]);
    expect(given.extra).toBe("Το διάβασα.");

    // Μια διεύθυνση που απλώς αναφέρεται στην κουβέντα, χωρίς να ζητηθεί ανάγνωση, δεν ανοίγει μόνη της.
    await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Το site μου είναι https://example.org/ αλλά δεν έχει κάτι ακόμη");
    expect(calls).toHaveLength(1);

    // Διεύθυνση που "θυμήθηκε" το μοντέλο και δεν υπάρχει πουθενά: αγνοείται.
    text = "Θα δω την πηγή.\n[ΑΝΟΙΞΕ: https://invented.example.net/news]";
    const invented = await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Πού μπορώ να μάθω περισσότερα;");
    expect(invented.reply).toBe("Θα δω την πηγή.");
    expect(invented.search).toBeNull();
    expect(calls).toHaveLength(1);

    // Διεύθυνση από υλικό που διάβασε (σύνδεσμος στους τίτλους της ημέρας): επιτρέπεται, με κάρτα.
    text = "Ας δω τα νέα.";
    await processTurn({ db, llm: model, lookup, now: at(15) }, u, "Ψάξε τις ειδήσεις της ημέρας");
    text = "Θέλω να διαβάσω ολόκληρο το άρθρο.\n[ΑΝΟΙΞΕ: https://www.ertnews.gr/arthro-1/]";
    const fromMaterial = await processTurn({ db, llm: model, lookup, now: at(2) }, u, "Τι λέει αναλυτικά το πρώτο;");
    expect(fromMaterial.search).toMatchObject({ source: "page", sourceLabel: "ιστοσελίδα", query: "https://www.ertnews.gr/arthro-1/" });
    await resolveSearch({ db, llm: model, lookup, now: at(1) }, u, fromMaterial.search!.id, true);
    expect(calls[calls.length - 1]).toBe("page:https://www.ertnews.gr/arthro-1/");
  });

  it("με μόνιμη άδεια διαβάζει τους τίτλους μία φορά τη μέρα, μόνη της, και το ξέρει", async () => {
    const u = await createUser(db, { email: "daily@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-12T06:00:00Z").getTime(); // 08:00 στην Ελλάδα
    const at = (min: number) => new Date((clock += min * 60000));
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Τίτλος"], text: "## Τίτλος\nΠερίληψη της ημέρας." };
    };
    let system = "";
    let reading = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return "Εντάξει.";
      },
      generateJson: async (req) => {
        if (!req.prompt.includes("<υλικό>")) return { perception: {}, impulses: {} };
        reading = req.system;
        return { found: true, message: "Διάβασα τα σημερινά.", retry: { source: "web", query: "κάτι άλλο" }, memories: [] };
      },
    };

    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Καλημέρα");
    // Χωρίς άδεια: τίποτα.
    expect((await pulse({ db, llm: model, lookup, now: at(1) }, u)).message).toBeNull();
    expect(calls).toEqual([]);
    expect(system).not.toContain("ΜΟΝΙΜΗ άδεια");

    // Η άδεια δίνεται· η κατάσταση του εγκεφάλου δεν πειράζεται.
    const before = await loadBrainState(db, u.id);
    await setAutoNews(db, u.id, true, at(0));
    const after = await loadBrainState(db, u.id);
    expect(after.autoNews).toBe(true);
    expect(after.values).toEqual(before.values);
    expect(after.turnCount).toBe(before.turnCount);

    const first = await pulse({ db, llm: model, lookup, now: at(1) }, u);
    expect(first.message).toBe("Διάβασα τα σημερινά.");
    expect(calls).toEqual(["headlines:σημερινοί τίτλοι"]);
    expect(reading).toContain("καθημερινή σου ανάγνωση");
    expect(reading).not.toContain("Το τελευταίο που σου είπε");
    expect(reading).not.toContain('"retry"');

    // Την ίδια μέρα δεν ξαναδιαβάζει, ούτε μετά από κουβέντα· και η άδεια επιβιώνει από την αποθήκευση της κατάστασης.
    await processTurn({ db, llm: model, lookup, now: at(30) }, u, "Τι λένε τα νέα;");
    expect(system).toContain("ΜΟΝΙΜΗ άδεια");
    await db.query(`UPDATE searches SET status = 'declined' WHERE user_id = $1 AND status = 'pending'`, [u.id]);
    await pulse({ db, llm: model, lookup, now: at(240) }, u);
    expect(calls.filter((c) => c.startsWith("headlines"))).toHaveLength(1);
    expect((await loadBrainState(db, u.id)).autoNews).toBe(true);

    // Την επόμενη μέρα, ξανά μία φορά.
    await pulse({ db, llm: model, lookup, now: at(24 * 60) }, u);
    await pulse({ db, llm: model, lookup, now: at(5) }, u);
    expect(calls.filter((c) => c.startsWith("headlines"))).toHaveLength(2);

    // Η άδεια ανακαλείται.
    await setAutoNews(db, u.id, false, at(0));
    await pulse({ db, llm: model, lookup, now: at(24 * 60) }, u);
    expect(calls.filter((c) => c.startsWith("headlines"))).toHaveLength(2);
  });

  it("μεγάλη σελίδα: περιγραφή πρώτα, ολόκληρη στη βάση, και σε κάθε ερώτηση μόνο το σχετικό κομμάτι", async () => {
    const u = await createUser(db, { email: "doc@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-13T09:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const url = "https://example.com/thalassa";
    const filler = (n: number) => `ΑΣΧΕΤΟ-ΤΜΗΜΑ-${n}: γενικά λόγια για κύματα, ρεύματα και παλίρροιες. `.repeat(40);
    const page =
      "## Η ζωή στον ωκεανό\nexample.com\n" +
      [filler(1), filler(2), filler(3), filler(4), "Οι φυσητήρες βουτούν σε βάθος 2.250 μέτρων για να κυνηγήσουν καλαμάρια.", filler(5), filler(6)].join("\n\n");
    expect(page.indexOf("φυσητήρες")).toBeGreaterThan(8000); // πολύ πέρα από όσα χωρούσαν πριν
    const calls: string[] = [];
    const lookup = async (source: string, query: string) => {
      calls.push(`${source}:${query}`);
      return { titles: ["Η ζωή στον ωκεανό"], text: page };
    };
    let system = "";
    let readingSystem = "";
    let readingPrompt = "";
    let text = "Ας το δω.";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return text;
      },
      generateJson: async (req) => {
        if (!req.prompt.includes("<υλικό>")) return { perception: {}, impulses: {} };
        readingSystem = req.system;
        readingPrompt = req.prompt;
        return llm.generateJson(req);
      },
    };

    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Γεια");
    const read = await processTurn({ db, llm: model, lookup, now: at(1) }, u, `Διάβασε αυτό: ${url}`);
    // Η πρώτη ανάγνωση βλέπει ολόκληρη τη σελίδα και δίνει περιγραφή.
    expect(readingSystem).toContain("ΠΡΩΤΗ ΑΝΑΓΝΩΣΗ");
    expect(readingPrompt).toContain("2.250 μέτρων");
    expect(read.extra).toContain("Είναι μια σελίδα για «Η ζωή στον ωκεανό»");
    // Στη βάση: η περιγραφή ως υλικό, ολόκληρο το κείμενο χωριστά, και μια ανάμνηση με τη διεύθυνση.
    const [row] = await db.query(`SELECT material, full_text FROM searches WHERE user_id = $1 AND source = 'page'`, [u.id]);
    expect(row.material).toContain("ΠΕΡΙΓΡΑΦΗ: Σελίδα με θέμα");
    expect(row.material).toContain("ΕΝΟΤΗΤΕΣ:\n- Εισαγωγή");
    expect(row.material).not.toContain("φυσητήρες");
    expect(row.full_text).toBe(page);
    expect((await listMemories(db, u.id)).some((m) => m.detail.includes(url))).toBe(true);

    // Επόμενη ερώτηση: στο context μπαίνει η περιγραφή και ΜΟΝΟ το κομμάτι που την αφορά.
    await processTurn({ db, llm: model, lookup, now: at(2) }, u, "Σε τι βάθος βουτάνε οι φυσητήρες;");
    expect(system).toContain("ΠΕΡΙΓΡΑΦΗ: Σελίδα με θέμα");
    expect(system).toContain("βουτούν σε βάθος 2.250 μέτρων");
    const shown = system.slice(system.indexOf("ΑΠΟΣΠΑΣΜΑΤΑ ΤΗΣ ΣΕΛΙΔΑΣ"), system.indexOf("ΓΙΑ ΑΥΤΗ ΤΗΝ ΑΠΑΝΤΗΣΗ"));
    expect(shown).toContain("2.250 μέτρων");
    expect(shown).not.toMatch(/ΑΣΧΕΤΟ-ΤΜΗΜΑ-[1236]/);
    expect(shown.length).toBeLessThan(2000);
    expect(system.length).toBeLessThan(page.length);
    // Σκορ ή αριθμοί από το απόσπασμα δεν θεωρούνται επινόηση: το έχει μπροστά της.

    // Ένα σύντομο μήνυμα-συνέχεια κρατά το νήμα της προηγούμενης ερώτησης.
    await processTurn({ db, llm: model, lookup, now: at(2) }, u, "Καλά.");
    expect(system).toContain("2.250 μέτρων");
    // Όταν η κουβέντα φύγει από το θέμα: κανένα απόσπασμα, μόνο η περιγραφή.
    await processTurn({ db, llm: model, lookup, now: at(2) }, u, "Εντάξει λοιπόν.");
    expect(system).toContain("Κανένα σημείο της σελίδας δεν ταιριάζει");
    expect(system).not.toContain("2.250 μέτρων");

    // Δύο μέρες μετά ζητά να την ξανανοίξει: επιτρέπεται (την έχει διαβάσει) και δεν την ξανακατεβάζει.
    expect(calls).toEqual([`page:${url}`]);
    text = `Θέλω να την ξαναδώ.\n[ΑΝΟΙΞΕ: ${url}]`;
    const again = await processTurn({ db, llm: model, lookup, now: at(2 * 24 * 60) }, u, "Θυμάσαι εκείνη τη σελίδα για τη θάλασσα;");
    expect(again.search).toMatchObject({ source: "page", query: url });
    await resolveSearch({ db, llm: model, lookup, now: at(1) }, u, again.search!.id, true);
    expect(calls).toEqual([`page:${url}`]);
    expect(readingPrompt).toContain("2.250 μέτρων");
  });

  it("ψάχνει στη σελίδα και με τις έννοιες πίσω από τα λόγια του: «με τινάζει η πρίζα» βρίσκει το ρεύμα", async () => {
    const u = await createUser(db, { email: "terms@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-13T15:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    const filler = (n: number) => `Τμήμα ${n}: ιστορικά στοιχεία για τους αρχαίους και το κεχριμπάρι. `.repeat(45);
    const page =
      "## Ηλεκτρισμός\nexample.com\n" +
      [filler(1), filler(2), filler(3), "Το ηλεκτρικό ρεύμα διαπερνά το σώμα όταν υπάρχει διαφορά τάσης, και προκαλεί ηλεκτροπληξία.", filler(4)].join("\n\n");
    const lookup = async () => ({ titles: ["Ηλεκτρισμός"], text: page });
    let system = "";
    let perceive = "";
    let terms: string[] = [];
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return "Ας το δω.";
      },
      generateJson: async (req) => {
        if (req.prompt.includes("<υλικό>")) return llm.generateJson(req);
        if (req.prompt.includes("<απάντηση>")) return {};
        perceive = req.prompt;
        return { perception: {}, impulses: {}, note: "ρωτά γιατί τον χτυπά το ρεύμα", terms };
      },
    };
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Γεια");
    await processTurn({ db, llm: model, lookup, now: at(1) }, u, "Διάβασε αυτό: https://example.com/ilektrismos");

    // Η αντίληψη ξέρει ποια σελίδα έχει μπροστά της, για να σκεφτεί όρους που ταιριάζουν.
    await processTurn({ db, llm: model, lookup, now: at(2) }, u, "Ωραία, πάμε παρακάτω.");
    expect(perceive).toContain("Σελίδες που έχει διαβάσει πρόσφατα");
    expect(perceive).toContain("ΠΕΡΙΓΡΑΦΗ: Σελίδα με θέμα «Ηλεκτρισμός»");

    // Με τα λόγια του μόνο, η σελίδα δεν δίνει τίποτα.
    await processTurn({ db, llm: model, lookup, now: at(2) }, u, "γιατί με τινάζει η πρίζα;");
    expect(system).toContain("Κανένα σημείο της σελίδας δεν ταιριάζει");

    // Με τις έννοιες που κατάλαβε πίσω από την ερώτηση, βρίσκει την παράγραφο.
    terms = ["ηλεκτρικό ρεύμα", "τάση", "ηλεκτροπληξία", 7 as unknown as string, ""];
    const found = await processTurn({ db, llm: model, lookup, now: at(2) }, u, "μα γιατί με τινάζει η πρίζα;");
    expect(system).toContain("διαφορά τάσης, και προκαλεί ηλεκτροπληξία");
    expect(found.debug.note).toBe("ρωτά γιατί τον χτυπά το ρεύμα · Έννοιες: ηλεκτρικό ρεύμα, τάση, ηλεκτροπληξία");
  });

  it("σκέφτεται ιδιωτικά πριν μιλήσει: η σκέψη δεν φτάνει ποτέ στον συνομιλητή, αλλά τη θυμάται", async () => {
    const u = await createUser(db, { email: "think@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-14T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let system = "";
    let output = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return output;
      },
      generateJson: async () => ({ perception: {}, impulses: {} }),
    };

    // Η σκέψη αφαιρείται, αποθηκεύεται χωριστά και φαίνεται μόνο στον πίνακα της εσωτερικής κατάστασης.
    output = "<σκέψη>Μου ήρθε να τον κοροϊδέψω, αλλά είναι κουρασμένος. Καλύτερα ήρεμα.</σκέψη>\nΚαλημέρα, πώς πέρασες;";
    const first = await processTurn({ db, llm: model, now: at(1) }, u, "Καλημέρα, ήταν δύσκολη μέρα.");
    expect(system).toContain("Πριν απαντήσεις, γράψε μια εσωτερική σκέψη");
    expect(first.reply).toBe("Καλημέρα, πώς πέρασες;");
    expect(first.debug.thought).toBe("Μου ήρθε να τον κοροϊδέψω, αλλά είναι κουρασμένος. Καλύτερα ήρεμα.");
    const chat = (await recentMessages(db, u.id, 5)).map((m) => m.content).join("\n");
    expect(chat).not.toContain("σκέψη");
    expect(chat).not.toContain("κοροϊδέψω");

    // Στην επόμενη απάντηση την έχει μπροστά της, ως κάτι ιδιωτικό.
    output = "Ναι;";
    await processTurn({ db, llm: model, now: at(5) }, u, "Τίποτα, απλά κουράστηκα.");
    expect(system).toContain("ΤΙ ΣΚΕΦΤΗΚΕΣ ΠΡΟΣΦΑΤΑ (ιδιωτικά");
    expect(system).toContain("Μου ήρθε να τον κοροϊδέψω");

    // Σκέψη που δεν έκλεισε και δεν άφησε απάντηση: ξαναρωτά χωρίς σκέψη, η απάντηση δεν χάνεται.
    let calls = 0;
    const flaky: LlmProvider = {
      ...model,
      name: "flaky",
      generateText: async (req) => {
        calls++;
        system = req.system;
        return req.system.includes("Πριν απαντήσεις, γράψε") ? "<σκέψη>Δεν ξέρω τι να πω" : "Εδώ είμαι.";
      },
    };
    const recovered = await processTurn({ db, llm: flaky, now: at(5) }, u, "Εντάξει;");
    expect(calls).toBe(2);
    expect(recovered.reply).toBe("Εδώ είμαι.");
    expect(system).toContain("ΕΣΩΤΕΡΙΚΗ ΣΚΕΨΗ: καμία τώρα");

    // Ο αυθόρμητος μιλά χωρίς σκέψη: καμία σκέψη δεν ζητείται ούτε αποθηκεύεται.
    const st = await loadBrainState(db, u.id);
    await db.query(`UPDATE brain_states SET dims = $2::text::jsonb WHERE user_id = $1`, [
      u.id,
      JSON.stringify({ ...st.values, spontaneity: 100, restraint: 0, anger: 0, fear: 0, hurt: 0 }),
    ]);
    output = "Χαχα, ναι.";
    const quick = await processTurn({ db, llm: model, now: at(1) }, u, "χαχα");
    expect(system).toContain("ΕΣΩΤΕΡΙΚΗ ΣΚΕΨΗ: καμία τώρα");
    expect(quick.debug.thought).toBe("");
    expect(quick.reply).toBe("Χαχα, ναι.");
  });

  it("όταν σωπαίνεις μπορεί να σκεφτεί χωρίς να μιλήσει — και να το ξανασκεφτεί αργότερα", async () => {
    const u = await createUser(db, { email: "quiet@x.gr", name: "Βασίλης", passwordHash: "x" });
    let clock = new Date("2026-11-15T10:00:00Z").getTime();
    const at = (min: number) => new Date((clock += min * 60000));
    let output = "<σκέψη>Θα ήθελα να τον ρωτήσω για τη δουλειά, αλλά είναι νωρίς. Θα περιμένω.</σκέψη>\n[ΣΙΩΠΗ]";
    let system = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return output;
      },
      generateJson: async () => ({ perception: {}, impulses: {} }),
    };
    await processTurn({ db, llm: llm, now: at(1) }, u, "Γεια σου!");
    const before = (await recentMessages(db, u.id, 10)).length;

    const wait = (await pulse({ db, llm: model, now: at(0.5) }, u)).nextInSec!;
    const silent = await pulse({ db, llm: model, now: at(wait / 60) }, u);
    expect(silent.message).toBeNull();
    expect(silent.nextInSec).toBe(3600);
    expect((await recentMessages(db, u.id, 10)).length).toBe(before); // τίποτα δεν εμφανίστηκε στην κουβέντα
    expect(system).toContain("[ΣΙΩΠΗ]");

    // Αμέσως μετά, δεν ξανασκέφτεται· υπάρχει αναμονή.
    let asked = 0;
    const counting: LlmProvider = { ...model, generateText: async (req) => { asked++; return model.generateText(req); } };
    const again = await pulse({ db, llm: counting, now: at(5) }, u);
    expect(again.message).toBeNull();
    expect(asked).toBe(0);
    expect(again.nextInSec).toBeGreaterThan(50 * 60);

    // Η σκέψη που δεν είπε την έχει μπροστά της, επισημασμένη, όταν τελικά μιλήσει.
    output = "Σκεφτόμουν κάτι για τη δουλειά σου. Πώς πάει;";
    await pulse({ db, llm: model, now: at(70) }, u);
    expect(system).toContain("(δεν το είπες): Θα ήθελα να τον ρωτήσω για τη δουλειά");
    expect(system).toContain("μπορείς να επιστρέψεις σε κάτι που σκέφτηκες και δεν είπες");
  });

  it("ξέρει πότε μιλήσατε χθες το βράδυ, ακόμη κι όταν ρωτά ένα λεπτό μέσα στη σημερινή κουβέντα", async () => {
    const u = await createUser(db, { email: "time@x.gr", name: "Βασίλης", passwordHash: "x" });
    let system = "";
    let thoughtAsked = "";
    const model: LlmProvider = {
      name: "model",
      embed: llm.embed.bind(llm),
      generateText: async (req) => {
        system = req.system;
        return "Εντάξει.";
      },
      generateJson: async () => ({ perception: {}, impulses: {} }),
    };
    const t = (iso: string) => new Date(iso);
    // Παρασκευή 13/11, 20:41–21:12 ώρα Ελλάδας.
    await processTurn({ db, llm, now: t("2026-11-13T18:41:00Z") }, u, "Καλησπέρα!");
    await processTurn({ db, llm, now: t("2026-11-13T18:58:00Z") }, u, "Πώς πάει;");
    await processTurn({ db, llm, now: t("2026-11-13T19:12:00Z") }, u, "Καληνύχτα!");
    // Σάββατο 14/11, 08:08, και 08:10.
    await processTurn({ db, llm: model, now: t("2026-11-14T06:08:00Z") }, u, "Καλημέρα");
    expect(system).toContain("Είχε να σου γράψει περίπου 11 ώρες");
    await processTurn({ db, llm: model, now: t("2026-11-14T06:10:00Z") }, u, "Πόσος χρόνος πέρασε από τότε που μιλήσαμε;");
    // Τώρα η κουβέντα είναι ζωντανή, και το «προηγούμενο μήνυμα» είναι πριν από 2 λεπτά — αλλά ξέρει και τη χθεσινή.
    expect(system).toContain("το προηγούμενο μήνυμά του ήρθε πριν από 2 λεπτά");
    expect(system).toContain("Η προηγούμενη κουβέντα σας ξεκίνησε χθες το βράδυ (20:41) και τελείωσε στις 21:12");
    expect(system).toContain("έχουν περάσει περίπου 11 ώρες");
    expect(system).toContain("Η κουβέντα ξεκίνησε σήμερα το πρωί (08:08)");
    expect(system).toMatch(/Τώρα: Σάββατο 14 Νοεμβρίου 2026 στις 8:10/);

    // Η σκέψη της ξέρει ότι πρέπει να λάβει υπόψη τον χρόνο.
    const spy: LlmProvider = { ...model, generateText: async (req) => { thoughtAsked = req.system; return "Εντάξει."; } };
    await processTurn({ db, llm: spy, now: t("2026-11-14T06:12:00Z") }, u, "Τι ώρα είναι;");
    expect(thoughtAsked).toContain("Σκέψου και τον χρόνο");
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
