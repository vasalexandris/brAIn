import { describe, expect, it } from "vitest";
import { applyAppraisal, initialValues } from "@/brain/state";
import { extractThought, thinkingDepth, thoughtDirective } from "@/brain/thought";

const ctx = { message: "Τι κάνεις;", hasMaterial: false };

describe("πόσο σκέφτεται πριν μιλήσει", () => {
  it("στις αρχικές τιμές: μια στιγμιαία σκέψη", () => {
    expect(thinkingDepth(initialValues(), ctx)).toBe(1);
  });

  it("ο αυθόρμητος μιλά κατευθείαν· ο συγκρατημένος σκέφτεται περισσότερο", () => {
    const base = initialValues();
    expect(thinkingDepth({ ...base, spontaneity: 95, restraint: 10 }, ctx)).toBe(0);
    expect(thinkingDepth({ ...base, spontaneity: 10, restraint: 95 }, ctx)).toBe(2);
  });

  it("η πρόκληση και η φορτισμένη στιγμή την κάνουν προσεκτική", () => {
    let v = initialValues();
    for (let i = 0; i < 3; i++) {
      v = applyAppraisal(v, { perception: { p_provocation: 90, p_hostility: 80 }, impulses: { anger: 80, fear: 40 } });
    }
    expect(thinkingDepth(v, ctx)).toBe(2);
  });

  it("όταν ζητούνται γεγονότα ή αριθμοί, δεν μιλά ποτέ χωρίς έστω μια ματιά — ακόμη και ο πιο αυθόρμητος", () => {
    const spontaneous = { ...initialValues(), spontaneity: 100, restraint: 0 };
    expect(thinkingDepth(spontaneous, ctx)).toBe(0);
    expect(thinkingDepth(spontaneous, { message: "Ποιο ήταν το σκορ χθες;", hasMaterial: false })).toBe(1);
    expect(thinkingDepth(spontaneous, { message: "Πόσο κάνει 12 επί 8", hasMaterial: false })).toBe(1);
  });

  it("η οδηγία αλλάζει με το βάθος· χωρίς σκέψη δεν ζητά μπλοκ", () => {
    expect(thoughtDirective(0)).not.toContain("<σκέψη>");
    expect(thoughtDirective(1)).toContain("μία ή δύο προτάσεις");
    expect(thoughtDirective(2)).toContain("τρεις έως πέντε προτάσεις");
    for (const d of [1, 2] as const) {
      expect(thoughtDirective(d)).toContain("το είδα γραμμένο ή το βγάζω από το μυαλό μου");
      expect(thoughtDirective(d)).toContain("ΔΕΝ αναφέρει τη σκέψη");
    }
  });
});

describe("διαχωρισμός σκέψης και απάντησης", () => {
  it("βγάζει τη σκέψη και κρατά μόνο την απάντηση", () => {
    expect(extractThought("<σκέψη>Μου ήρθε να πω κάτι αιχμηρό, αλλά καλύτερα όχι.</σκέψη>\nΚαλημέρα.")).toEqual({
      thought: "Μου ήρθε να πω κάτι αιχμηρό, αλλά καλύτερα όχι.",
      text: "Καλημέρα.",
      unclosed: false,
    });
    expect(extractThought("Χωρίς σκέψη.")).toEqual({ thought: "", text: "Χωρίς σκέψη.", unclosed: false });
  });

  it("ανέχεται ό,τι κι αν γράψει το μοντέλο, και δεν αφήνει ποτέ σκέψη να διαρρεύσει", () => {
    // Δύο μπλοκ, και πεζά/κεφαλαία.
    const two = extractThought("<σκέψη>α</σκέψη>Μία. <ΣΚΈΨΗ>β</ΣΚΈΨΗ>Δύο.");
    expect(two.text).toBe("Μία. Δύο.");
    expect(two.thought).toBe("α β");

    // Δεν έκλεισε, αλλά υπάρχει κενή γραμμή: ό,τι μετά είναι η απάντηση.
    const open = extractThought("<σκέψη>Σκέφτομαι πολύ.\n\nΝαι, εδώ είμαι.");
    expect(open).toEqual({ thought: "Σκέφτομαι πολύ.", text: "Ναι, εδώ είμαι.", unclosed: true });

    // Δεν έκλεισε και δεν υπάρχει απάντηση: όλα σκέψη, κενή απάντηση (ο καλών θα ξαναρωτήσει).
    expect(extractThought("<σκέψη>Δεν ξέρω τι να πω")).toEqual({ thought: "Δεν ξέρω τι να πω", text: "", unclosed: true });

    // Κολλημένη σήμανση.
    expect(extractThought("Γεια </σκέψη>σου").text).toBe("Γεια σου");
    expect(extractThought("<σκέψη>x</σκέψη>").text).toBe("");
  });
});
