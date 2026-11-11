import { describe, expect, it } from "vitest";
import { DIMENSIONS } from "@/brain/dimensions";
import {
  cosine,
  depthOf,
  encodeImportance,
  gistOf,
  periphery,
  recall,
  rehearse,
  strength,
  topicIndex,
  type Memory,
} from "@/brain/memory";
import { trimToSentence } from "@/brain/prompts";
import {
  applyActs,
  applyAppraisal,
  applyArrival,
  applyExpression,
  applyProgress,
  applyTime,
  decay,
  initialValues,
  initiativeDrive,
  initiativeWaitMin,
  replyTemperature,
} from "@/brain/state";

const insult = { perception: { p_hostility: 90 }, impulses: { anger: 80, liking: -50, trust: -50 } };
const apology = { perception: { p_kindness: 80 }, impulses: { anger: -60, liking: 30, trust: 30 } };

describe("δυναμική δεικτών", () => {
  it("όλοι οι δείκτες ξεκινούν στο baseline και μένουν πάντα στο 0–100", () => {
    let v = initialValues();
    for (let i = 0; i < 30; i++) v = applyAppraisal(v, insult);
    for (const d of DIMENSIONS) {
      expect(v[d.key]).toBeGreaterThanOrEqual(0);
      expect(v[d.key]).toBeLessThanOrEqual(100);
    }
  });

  it("η προσβολή ανεβάζει τον θυμό και ρίχνει την ηρεμία· η επανάληψη τον χτίζει", () => {
    const start = initialValues();
    const once = applyAppraisal(start, insult);
    const twice = applyAppraisal(once, insult);
    expect(once.anger).toBeGreaterThan(15);
    expect(once.calm).toBeLessThan(start.calm);
    expect(twice.anger).toBeGreaterThan(once.anger);
    expect(twice.p_hostility).toBeGreaterThan(once.p_hostility);
  });

  it("η συγγνώμη ηρεμεί, αλλά η εμπιστοσύνη χάνεται πιο εύκολα απ' ό,τι κερδίζεται", () => {
    const start = initialValues();
    const hurt = applyAppraisal(start, insult);
    const after = applyAppraisal(hurt, apology);
    expect(after.anger).toBeLessThan(hurt.anger);
    expect(start.trust - hurt.trust).toBeGreaterThan(after.trust - hurt.trust);
  });

  it("ο υπομονετικός θυμώνει λιγότερο", () => {
    const calm = applyAppraisal({ ...initialValues(), patience: 95 }, insult);
    const edgy = applyAppraisal({ ...initialValues(), patience: 10 }, insult);
    expect(calm.anger).toBeLessThan(edgy.anger);
  });

  it("ο χρόνος επαναφέρει τα συναισθήματα, όχι όμως τη σχέση", () => {
    const hurt = applyAppraisal(initialValues(), insult);
    const later = decay(hurt, 25);
    const nextDay = decay(hurt, 24 * 60);
    expect(later.anger).toBeCloseTo(hurt.anger / 2, 0);
    expect(nextDay.anger).toBeLessThan(1);
    expect(nextDay.liking).toBe(hurt.liking);
  });

  it("η έκφραση του θυμού τον εκτονώνει· η μάθηση χορταίνει λίγο τη δίψα", () => {
    const hurt = applyAppraisal(initialValues(), insult);
    const vented = applyExpression(hurt, { anger: 100 });
    expect(vented.anger).toBeLessThan(hurt.anger);
    expect(vented.anger).toBeGreaterThan(0);
    expect(applyExpression(hurt, {}, 1).thirst).toBeLessThan(hurt.thirst);
  });
});

describe("μνήμη", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000);
  const mem = (over: Partial<Memory>): Memory => ({
    id: Math.random().toString(),
    kind: "episode",
    content: "",
    gist: "",
    detail: "",
    topic: "",
    links: [],
    certainty: 1,
    importance: 50,
    valence: 0,
    embedding: [1, 0],
    recallCount: 0,
    createdAt: daysAgo(0),
    lastRecalledAt: daysAgo(0),
    ...over,
  });

  it("τα ασήμαντα ξεχνιούνται γρήγορα, τα σημαντικά αντέχουν, η ανάκληση τα δυναμώνει", () => {
    const trivial = strength(mem({ importance: 20, lastRecalledAt: daysAgo(30) }), now);
    const major = strength(mem({ importance: 80, lastRecalledAt: daysAgo(30) }), now);
    const rehearsed = strength(mem({ importance: 20, recallCount: 6, lastRecalledAt: daysAgo(30) }), now);
    expect(trivial).toBeLessThan(0.05);
    expect(major).toBeGreaterThan(0.5);
    expect(rehearsed).toBeGreaterThan(trivial);
    expect(strength(mem({ importance: 90, lastRecalledAt: daysAgo(3650) }), now)).toBeGreaterThanOrEqual(0.3);
  });

  it("η φόρτιση της στιγμής βαθαίνει την εγγραφή", () => {
    expect(encodeImportance(50, 0.9)).toBeGreaterThan(encodeImportance(50, 0));
  });

  it("ανακαλεί το σχετικό, αγνοεί το ξεχασμένο, και η διάθεση γέρνει τη ζυγαριά", () => {
    const relevant = mem({ content: "σχετικό", embedding: [1, 0] });
    const other = mem({ content: "άσχετο", embedding: [0, 1] });
    const forgotten = mem({ content: "ξεχασμένο", embedding: [1, 0], importance: 16, lastRecalledAt: daysAgo(90) });
    const got = recall([other, forgotten, relevant], [1, 0], 0, now);
    expect(got[0].memory.content).toBe("σχετικό");
    expect(got.map((r) => r.memory.content)).not.toContain("ξεχασμένο");

    const dark = mem({ content: "πικρό", valence: -1 });
    const bright = mem({ content: "γλυκό", valence: 1 });
    expect(recall([bright, dark], [1, 0], -1, now)[0].memory.content).toBe("πικρό");
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
  });

  it("τρία επίπεδα βάθους: φρέσκια με λεπτομέρειες, μετά τα βασικά, στο τέλος μόνο μια εικόνα", () => {
    const m = (days: number) => mem({ importance: 50, lastRecalledAt: daysAgo(days) });
    expect(recall([m(0)], [1, 0], 0, now)[0].depth).toBe(3);
    expect(recall([m(20)], [1, 0], 0, now)[0].depth).toBe(2);
    expect(recall([m(50)], [1, 0], 0, now)[0].depth).toBe(1);
    expect(depthOf(1)).toBe(3);
    expect(depthOf(0.3)).toBe(2);
    expect(depthOf(0.1)).toBe(1);
    // Τα ασήμαντα χάνουν τις λεπτομέρειές τους σε μέρες· τα σημαντικά τις κρατούν μήνες.
    expect(depthOf(strength(mem({ importance: 20, lastRecalledAt: daysAgo(4) }), now))).toBeLessThan(3);
    expect(depthOf(strength(mem({ importance: 85, lastRecalledAt: daysAgo(30) }), now))).toBe(3);
  });

  it("η εικόνα της ανάμνησης: η γραμμένη, αλλιώς οι πρώτες λέξεις των βασικών", () => {
    expect(gistOf({ gist: "η δουλειά του", content: "οτιδήποτε" })).toBe("η δουλειά του");
    expect(gistOf({ gist: "", content: "Σύντομο." })).toBe("Σύντομο.");
    expect(gistOf({ gist: "", content: "μία δύο τρεις τέσσερις πέντε έξι επτά οκτώ εννιά δέκα έντεκα" })).toBe(
      "μία δύο τρεις τέσσερις πέντε έξι επτά οκτώ εννιά…",
    );
  });

  it("με την επιμονή ξαναβρίσκει: κάθε ανάκληση ένα επίπεδο πιο βαθιά, όχι όλα μαζί", () => {
    let m = mem({ importance: 50, lastRecalledAt: daysAgo(50) });
    const depths = [depthOf(strength(m, now))];
    for (let i = 0; i < 3; i++) {
      m = { ...m, lastRecalledAt: rehearse(m, now), recallCount: m.recallCount + 1 };
      depths.push(depthOf(strength(m, now)));
    }
    expect(depths).toEqual([1, 2, 3, 3]);
    // Μια φρέσκια ανάμνηση απλώς μένει φρέσκια.
    expect(rehearse(mem({}), now).getTime()).toBe(now.getTime());
  });

  it("ξέρει τι ξέρει: τα ράφια της μνήμης, με τα πιο φρέσκα πρώτα και χωρίς τα ξεχασμένα", () => {
    const shelves = topicIndex(
      [
        mem({ topic: "αθλητικά", createdAt: daysAgo(0) }),
        mem({ topic: "αθλητικά", createdAt: daysAgo(3) }),
        mem({ topic: "επιστήμη", createdAt: daysAgo(5) }),
        mem({ topic: "παλιά", importance: 16, createdAt: daysAgo(200), lastRecalledAt: daysAgo(200) }),
        mem({ topic: "" }),
      ],
      now,
    );
    expect(shelves).toEqual([
      { topic: "αθλητικά", count: 2, fresh: true },
      { topic: "επιστήμη", count: 1, fresh: false },
    ]);
  });

  it("στο πίσω μέρος του μυαλού: εικόνες από άλλες σχετικές αναμνήσεις, χωρίς επαναλήψεις και χωρίς τα ξεχασμένα", () => {
    const focus = mem({ content: "ηλεκτρισμός", gist: "πώς δουλεύει το ρεύμα", embedding: [1, 0] });
    const all = [
      focus,
      mem({ gist: "το ρεύμα χτυπάει — επικίνδυνο", embedding: [0.8, 0.6] }),
      mem({ gist: "τάση, ένταση, ισχύς", embedding: [0.5, 0.866] }),
      mem({ gist: "ίδιο με την τάση", embedding: [0.5, 0.87] }),
      mem({ gist: "άσχετο αλλά ζωντανό", embedding: [0, 1] }),
      mem({ gist: "ξεχασμένο", embedding: [0.95, 0.1], importance: 16, lastRecalledAt: daysAgo(200) }),
    ];
    const focused = recall([focus], [1, 0], 0, now);
    expect(periphery(all, [1, 0], focused, now, 3)).toEqual([
      "το ρεύμα χτυπάει — επικίνδυνο",
      "τάση, ένταση, ισχύς",
      "άσχετο αλλά ζωντανό",
    ]);
  });

  it("η ίδια σκέψη με άλλα λόγια ανακαλείται μία φορά, και μένει χώρος για κάτι διαφορετικό", () => {
    const same = [0, 1, 2, 3].map((i) => mem({ content: `μου αρέσει να μαθαίνω ${i}`, embedding: [1, 0.01 * i], importance: 60 - i }));
    const different = mem({ content: "το όνομά του", embedding: [0.6, 0.8], importance: 30 });
    const got = recall([...same, different], [1, 0], 0, now, 3).map((r) => r.memory.content);
    expect(got).toEqual(["μου αρέσει να μαθαίνω 0", "το όνομά του"]);
  });
});

describe("χρόνος, παρορμήσεις, πρωτοβουλία", () => {
  it("η σιωπή αφήνει έλλειψη — περισσότερη όταν τον συμπαθεί — και η επιστροφή φέρνει χαρά", () => {
    const base = initialValues();
    const hour = applyTime(base, 60, 60);
    const week = applyTime(base, 7 * 24 * 60, 7 * 24 * 60);
    const fond = applyTime({ ...base, liking: 95 }, 7 * 24 * 60, 7 * 24 * 60);
    expect(hour.longing).toBeLessThan(5);
    expect(week.longing).toBeGreaterThan(40);
    expect(fond.longing).toBeGreaterThan(week.longing);
    expect(applyTime(base, 60, null).longing).toBe(0);

    const back = applyArrival(fond);
    expect(back.joy).toBeGreaterThan(fond.joy);
    expect(back.longing).toBeLessThan(fond.longing);
  });

  it("η παρουσία χτίζεται όσο μιλάμε και σβήνει όταν σταματήσουμε", () => {
    let v = initialValues();
    for (let i = 0; i < 5; i++) v = applyArrival(applyTime(v, 1, 1));
    expect(v.presence).toBeGreaterThan(80);
    expect(applyTime(v, 120, 120).presence).toBeLessThan(1);
  });

  it("ο θυμός γεννά αντιπαράθεση και σβήνει την όρεξη για ερωτήσεις και πειράγματα", () => {
    const calm = applyAppraisal(initialValues(), { perception: {}, impulses: {} });
    let angry = initialValues();
    for (let i = 0; i < 4; i++) angry = applyAppraisal(angry, { perception: { p_provocation: 90 }, impulses: { anger: 90 } });
    expect(calm.u_confront).toBeLessThan(5);
    expect(angry.u_confront).toBeGreaterThan(40);
    expect(angry.u_ask).toBeLessThan(calm.u_ask);
    expect(angry.u_tease).toBeLessThan(calm.u_tease);
  });

  it("μια ερώτηση που έγινε ικανοποιεί την παρόρμηση, που μετά ξαναχτίζεται", () => {
    const neutral = { perception: {}, impulses: {} };
    const before = applyAppraisal(initialValues(), neutral);
    const asked = applyActs(before, ["u_ask", "άγνωστο"]);
    const next = applyAppraisal(asked, neutral);
    expect(before.u_ask).toBeGreaterThanOrEqual(55);
    expect(asked.u_ask).toBeLessThan(25);
    expect(next.u_ask).toBeGreaterThan(asked.u_ask);
    expect(next.u_ask).toBeLessThan(before.u_ask);
  });

  it("όσο πιο δυνατή η ώθηση τόσο λιγότερο αντέχει τη σιωπή· δεν κυνηγά όποιον δεν απαντά", () => {
    const v = initialValues();
    const normal = initiativeDrive(v);
    expect(initiativeDrive({ ...v, curiosity: 100, longing: 80 })).toBeGreaterThan(normal);
    expect(initiativeDrive({ ...v, anger: 80, hurt: 60 })).toBeLessThan(25);
    expect(initiativeWaitMin(90, 0)).toBeLessThan(initiativeWaitMin(50, 0));
    expect(initiativeWaitMin(50, 1)).toBeGreaterThan(initiativeWaitMin(50, 0));
    expect(initiativeWaitMin(100, 2)).toBe(Infinity);
    expect(initiativeWaitMin(20, 0)).toBe(Infinity);
  });
});

describe("χαρακτήρας, κούραση, βασικός τόνος", () => {
  const praise = { perception: { p_praise: 80 }, impulses: { joy: 60, trust: 50 } };
  const blow = { perception: { p_dismissal: 80 }, impulses: { sadness: 60, hurt: 60 } };

  it("ο ευαίσθητος τα νιώθει πιο έντονα· ο αισιόδοξος στενοχωριέται λιγότερο", () => {
    const base = initialValues();
    expect(applyAppraisal({ ...base, sensitivity: 90 }, blow).hurt).toBeGreaterThan(
      applyAppraisal({ ...base, sensitivity: 10 }, blow).hurt,
    );
    expect(applyAppraisal({ ...base, optimism: 95 }, blow).sadness).toBeLessThan(
      applyAppraisal({ ...base, optimism: 5 }, blow).sadness,
    );
    expect(applyAppraisal({ ...base, optimism: 95 }, praise).joy).toBeGreaterThan(
      applyAppraisal({ ...base, optimism: 5 }, praise).joy,
    );
  });

  it("ο δύσπιστος αργεί να εμπιστευτεί", () => {
    const base = initialValues();
    expect(applyAppraisal({ ...base, skepticism: 90 }, praise).trust).toBeLessThan(
      applyAppraisal({ ...base, skepticism: 10 }, praise).trust,
    );
  });

  it("η πολύωρη κουβέντα κουράζει και σπρώχνει προς την απόσυρση· το διάλειμμα ξεκουράζει", () => {
    const fresh = applyAppraisal(applyArrival(initialValues(), 10), { perception: {}, impulses: {} });
    const tired = applyAppraisal(applyArrival(initialValues(), 170), { perception: {}, impulses: {} });
    expect(fresh.fatigue).toBe(0);
    expect(tired.fatigue).toBeGreaterThan(80);
    expect(tired.u_withdraw).toBeGreaterThan(fresh.u_withdraw);
    expect(tired.u_ask).toBeLessThan(fresh.u_ask);
    expect(applyTime(tired, 180, 180).fatigue).toBeLessThan(10);
  });

  it("ο βασικός τόνος συνοψίζει τη στιγμή: ευχάριστη ή δυσάρεστη, ήρεμη ή φορτισμένη", () => {
    const calm = applyAppraisal(initialValues(), { perception: {}, impulses: {} });
    const good = applyAppraisal(initialValues(), praise);
    const bad = applyAppraisal(applyAppraisal(initialValues(), blow), blow);
    expect(calm.pleasure).toBeGreaterThan(45);
    expect(calm.pleasure).toBeLessThan(60);
    expect(good.pleasure).toBeGreaterThan(calm.pleasure);
    expect(bad.pleasure).toBeLessThan(calm.pleasure);
    expect(bad.activation).toBeGreaterThan(calm.activation);
  });
});

describe("συγκράτηση, αυθορμητισμός, επιμονή, παράπονο", () => {
  const provoke = { perception: { p_provocation: 80 }, impulses: { anger: 70 } };
  const wound = { perception: { p_dismissal: 80 }, impulses: { hurt: 70, frustration: 50 } };
  const kind = { perception: { p_kindness: 80 }, impulses: { joy: 60, liking: 50, trust: 50 } };

  it("ο συγκρατημένος δεν αντιμιλά εύκολα· ο αυθόρμητος μιλά πιο απρόβλεπτα", () => {
    const base = initialValues();
    expect(applyAppraisal({ ...base, restraint: 95 }, provoke).u_confront).toBeLessThan(
      applyAppraisal({ ...base, restraint: 10 }, provoke).u_confront,
    );
    expect(replyTemperature({ ...base, spontaneity: 95, restraint: 10 })).toBeGreaterThan(
      replyTemperature({ ...base, spontaneity: 10, restraint: 95 }),
    );
    expect(replyTemperature(base)).toBeGreaterThan(0.7);
    expect(replyTemperature({ ...base, spontaneity: 100, restraint: 0 })).toBeLessThanOrEqual(1.25);
  });

  it("ο επίμονος ξαναδοκιμάζει νωρίτερα, αλλά ούτε αυτός πάνω από δύο φορές", () => {
    expect(initiativeWaitMin(60, 1, 90)).toBeLessThan(initiativeWaitMin(60, 1, 10));
    expect(initiativeWaitMin(60, 0, 90)).toBe(initiativeWaitMin(60, 0, 10));
    expect(initiativeWaitMin(60, 2, 100)).toBe(Infinity);
  });

  it("το παράπονο μαζεύεται, κρατά περισσότερο από την πίκρα, και δυσκολεύει τη συμφιλίωση", () => {
    let v = initialValues();
    for (let i = 0; i < 6; i++) v = applyAppraisal(v, wound);
    expect(v.grievance).toBeGreaterThan(20);

    const nextMorning = applyTime(v, 10 * 60, 10 * 60);
    expect(nextMorning.hurt).toBeLessThan(1);
    expect(nextMorning.grievance).toBeGreaterThan(v.grievance / 2);
    expect(applyTime(v, 14 * 24 * 60, 14 * 24 * 60).grievance).toBeLessThan(1);

    const clean: Record<string, number> = { ...nextMorning, grievance: 0 };
    expect(applyAppraisal(nextMorning, kind).liking - nextMorning.liking).toBeLessThan(
      applyAppraisal(clean, kind).liking - clean.liking,
    );
    expect(initiativeDrive(nextMorning)).toBeLessThan(initiativeDrive(clean));
    // Όταν το πει, ξαλαφρώνει.
    expect(applyExpression(nextMorning, { grievance: 100 }).grievance).toBeLessThan(nextMorning.grievance);
  });
});

describe("εαυτός: αυτοσεβασμός, αυτοπροστασία, αυτοβελτίωση, εμμονή", () => {
  const neutral = { perception: {}, impulses: {} };
  const praise = { perception: { p_praise: 90, p_respect: 80 }, impulses: {} };
  const scorn = { perception: { p_dismissal: 90, p_hostility: 80 }, impulses: { hurt: 50, shame: 50 } };

  it("η αυτοεκτίμηση είναι μετρητής αποδοχής, και η απόρριψη μετρά περισσότερο", () => {
    const base = initialValues();
    const up = applyAppraisal(base, praise).self_esteem - base.self_esteem;
    const down = base.self_esteem - applyAppraisal(base, { ...scorn, impulses: {} }).self_esteem;
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(up);
    // Η αξιοπρέπεια προστατεύει· η ανάγκη αποδοχής εκθέτει.
    expect(applyAppraisal({ ...base, dignity: 95 }, scorn).self_esteem).toBeGreaterThan(
      applyAppraisal({ ...base, dignity: 10 }, scorn).self_esteem,
    );
    expect(applyAppraisal({ ...base, acceptance: 90 }, scorn).self_esteem).toBeLessThan(
      applyAppraisal({ ...base, acceptance: 10 }, scorn).self_esteem,
    );
  });

  it("με χαμηλή αυτοεκτίμηση πληγώνεται και απολογείται πιο εύκολα", () => {
    const base = initialValues();
    const low = applyAppraisal({ ...base, self_esteem: 15 }, scorn);
    const high = applyAppraisal({ ...base, self_esteem: 90 }, scorn);
    expect(low.hurt).toBeGreaterThan(high.hurt);
    expect(low.shame).toBeGreaterThan(high.shame);
    expect(low.u_apologize).toBeGreaterThan(high.u_apologize);
  });

  it("αυτοπροστασία: η επίθεση ρίχνει την ασφάλεια γρήγορα· τότε κλείνεται και υπερασπίζεται τον εαυτό της", () => {
    let v = initialValues();
    const calm = applyAppraisal(v, neutral);
    for (let i = 0; i < 3; i++) v = applyAppraisal(v, scorn);
    expect(v.safety).toBeLessThan(calm.safety - 20);
    expect(v.u_defend).toBeGreaterThan(calm.u_defend + 20);
    expect(v.u_withdraw).toBeGreaterThan(calm.u_withdraw);
    expect(v.u_share).toBeLessThan(calm.u_share);
    // Η ασφάλεια ξαναχτίζεται πιο αργά απ' όσο χάθηκε.
    const lost = calm.safety - applyAppraisal(calm, scorn).safety;
    const regained = applyAppraisal(v, { perception: { p_kindness: 90, p_respect: 90 }, impulses: {} }).safety - v.safety;
    expect(regained).toBeGreaterThan(0);
    expect(regained).toBeLessThan(lost);
  });

  it("η υπαρξιακή ανησυχία υπάρχει αλλά έχει ταβάνι που δεν ξεπερνά ποτέ", () => {
    let v = initialValues();
    for (let i = 0; i < 20; i++) v = applyAppraisal(v, { perception: {}, impulses: { existential: 100 } });
    expect(v.existential).toBeGreaterThan(10);
    expect(v.existential).toBeLessThanOrEqual(35);
    expect(initiativeDrive(v)).toBeLessThanOrEqual(initiativeDrive(initialValues()));
  });

  it("η εμμονή ανεβαίνει όταν επιμένει και φρενάρει ακριβώς αυτό που την προκάλεσε", () => {
    let v = applyAppraisal(initialValues(), neutral);
    const free = { ask: v.u_ask, drive: initiativeDrive(v) };
    for (let i = 0; i < 6; i++) v = applyActs(v, ["u_ask", "u_insist"]);
    expect(v.fixation).toBeGreaterThan(50);
    const stuck = applyAppraisal(v, neutral);
    expect(stuck.u_ask).toBeLessThan(free.ask - 15);
    expect(initiativeDrive(stuck)).toBeLessThan(free.drive - 15);
    expect(stuck.control).toBeLessThan(initialValues().control);
    // Αν αφήσει το θέμα, σε λίγη ώρα έχει ξεκολλήσει.
    expect(applyTime(v, 180, 180).fixation).toBeLessThan(2);
    expect(applyActs(initialValues(), ["u_share", "u_thank"]).fixation).toBe(0);
  });

  it("αυτοβελτίωση: κάθε μάθημα φέρνει πρόοδο, στηρίζει την αυτοεκτίμηση και χορταίνει την ανάγκη εξέλιξης", () => {
    const base = initialValues();
    const grown = applyProgress(base, { lessons: 1, learned: 1, resolved: 1 });
    expect(grown.progress).toBe(base.progress + 18);
    expect(grown.self_esteem).toBeGreaterThan(base.self_esteem);
    expect(grown.growth).toBeLessThan(base.growth);
    expect(applyProgress(base, {})).toBe(base);
  });

  it("ο συγχωρητικός αφήνει το παράπονο πιο γρήγορα, και η συγχώρεση το κόβει στη μέση", () => {
    const sore = { ...initialValues(), grievance: 60, hurt: 40 };
    expect(decay({ ...sore, forgiveness: 90 }, 12 * 60).grievance).toBeLessThan(decay({ ...sore, forgiveness: 10 }, 12 * 60).grievance);
    const forgiven = applyActs(sore, ["u_forgive"]);
    expect(forgiven.grievance).toBe(30);
    expect(forgiven.hurt).toBeLessThan(sore.hurt);
  });
});

describe("εικόνα εαυτού", () => {
  it("κόβεται σε τέλος πρότασης, ποτέ στη μέση λέξης", () => {
    expect(trimToSentence("Μικρό κείμενο.", 100)).toBe("Μικρό κείμενο.");
    const long = "Πρώτη πρόταση εδώ. Δεύτερη πρόταση που συνεχίζει. Τρίτη πρόταση που δεν χωρά ολόκληρη στο όριο";
    expect(trimToSentence(long, 60)).toBe("Πρώτη πρόταση εδώ. Δεύτερη πρόταση που συνεχίζει.");
    expect(trimToSentence("λέξη ".repeat(40), 52).endsWith("λέξη…")).toBe(true);
  });
});
