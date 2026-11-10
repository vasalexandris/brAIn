import { describe, expect, it } from "vitest";
import { DIMENSIONS } from "@/brain/dimensions";
import { cosine, encodeImportance, recall, strength, type Memory } from "@/brain/memory";
import {
  applyActs,
  applyAppraisal,
  applyArrival,
  applyExpression,
  applyTime,
  decay,
  initialValues,
  initiativeDrive,
  initiativeWaitMin,
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
