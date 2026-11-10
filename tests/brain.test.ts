import { describe, expect, it } from "vitest";
import { DIMENSIONS } from "@/brain/dimensions";
import { cosine, encodeImportance, recall, strength, type Memory } from "@/brain/memory";
import { applyAppraisal, applyExpression, decay, initialValues } from "@/brain/state";

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
