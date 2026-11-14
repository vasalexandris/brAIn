import { describe, expect, it } from "vitest";
import { approxSpan, calendarDaysAgo, clock, dayPart, sessionsFrom, when } from "@/brain/clock";
import { describeTime } from "@/brain/prompts";

// Νοέμβριος: η Ελλάδα είναι UTC+2.
const at = (iso: string) => new Date(iso);

describe("ρολόι", () => {
  it("ώρα και μέρος της ημέρας στην Ελλάδα, όχι στο UTC", () => {
    expect(clock(at("2026-11-13T19:04:00Z"))).toBe("21:04");
    expect(dayPart(at("2026-11-13T19:04:00Z"))).toBe("βράδυ"); // 21:04
    expect(dayPart(at("2026-11-14T06:08:00Z"))).toBe("πρωί"); // 08:08
    expect(dayPart(at("2026-11-14T00:30:00Z"))).toBe("νύχτα"); // 02:30
    expect(dayPart(at("2026-11-14T11:30:00Z"))).toBe("μεσημέρι"); // 13:30
    expect(dayPart(at("2026-11-14T14:30:00Z"))).toBe("απόγευμα"); // 16:30
  });

  it("η μέρα μετρά με το ημερολόγιο, όχι με τις 24 ώρες", () => {
    const now = at("2026-11-14T06:08:00Z"); // Σάββατο 08:08
    expect(calendarDaysAgo(at("2026-11-13T19:04:00Z"), now)).toBe(1); // Παρασκευή 21:04: μόλις 11 ώρες, αλλά χθες
    expect(calendarDaysAgo(at("2026-11-13T22:30:00Z"), now)).toBe(0); // 00:30 Σαββάτου: σήμερα
    expect(calendarDaysAgo(at("2026-11-10T10:00:00Z"), now)).toBe(4);
  });

  it("ώρες και μέρες όπως τις λέει κανείς", () => {
    const now = at("2026-11-14T06:08:00Z");
    expect(when(at("2026-11-14T06:00:00Z"), now)).toBe("σήμερα το πρωί (08:00)");
    expect(when(at("2026-11-13T19:04:00Z"), now)).toBe("χθες το βράδυ (21:04)");
    expect(when(at("2026-11-10T15:00:00Z"), now)).toMatch(/Τρίτη 10\/11 το απόγευμα \(17:00\)/);
    expect(approxSpan(0.5)).toBe("λίγα δευτερόλεπτα");
    expect(approxSpan(2)).toBe("2 λεπτά");
    expect(approxSpan(65)).toBe("περίπου μία ώρα");
    expect(approxSpan(11 * 60 + 10)).toBe("περίπου 11 ώρες");
    expect(approxSpan(30 * 60)).toBe("περίπου μία μέρα");
    expect(approxSpan(3 * 24 * 60)).toBe("περίπου 3 μέρες");
  });

  it("χωρίζει τα μηνύματα σε κουβέντες, πιο πρόσφατη πρώτη", () => {
    const t = (m: string) => at(`2026-11-13T${m}:00Z`);
    const sessions = sessionsFrom([t("19:15"), t("18:50"), t("19:00"), t("07:00"), t("07:20"), t("20:30")], 30);
    expect(sessions.map((s) => [s.start.toISOString().slice(11, 16), s.end.toISOString().slice(11, 16)])).toEqual([
      ["20:30", "20:30"],
      ["18:50", "19:15"],
      ["07:00", "07:20"],
    ]);
    expect(sessionsFrom([], 30)).toEqual([]);
  });
});

describe("περιγραφή του χρόνου στο prompt", () => {
  const prev = { start: at("2026-11-13T18:41:00Z"), end: at("2026-11-13T19:12:00Z") }; // χθες 20:41–21:12

  it("στη μέση κουβέντας ξέρει και την προηγούμενη, όχι μόνο το προηγούμενο μήνυμα", () => {
    const now = at("2026-11-14T06:12:00Z"); // σήμερα 08:12
    const text = describeTime({ now, silenceMin: 2, sessionMin: 4, sessionStart: at("2026-11-14T06:08:00Z"), previous: prev });
    expect(text).toContain("Είναι πρωί.");
    expect(text).toContain("το προηγούμενο μήνυμά του ήρθε πριν από 2 λεπτά");
    expect(text).toContain("Η κουβέντα ξεκίνησε σήμερα το πρωί (08:08)");
    expect(text).toContain("Η προηγούμενη κουβέντα σας ξεκίνησε χθες το βράδυ (20:41) και τελείωσε στις 21:12");
    expect(text).toContain("έχουν περάσει περίπου 11 ώρες");
    expect(text).toContain("εννοεί συνήθως την ΠΡΟΗΓΟΥΜΕΝΗ κουβέντα");
  });

  it("όταν επιστρέφει μετά από ώρες, το λέει με «περίπου»", () => {
    const text = describeTime({ now: at("2026-11-14T06:08:00Z"), silenceMin: 11 * 60, sessionMin: 0, previous: prev });
    expect(text).toContain("Είχε να σου γράψει περίπου 11 ώρες. Μόλις επέστρεψε.");
  });

  it("πρώτη φορά, και κουβέντα χωρίς προηγούμενη", () => {
    const now = at("2026-11-14T06:08:00Z");
    expect(describeTime({ now, silenceMin: null, sessionMin: 0 })).toBe("Είναι πρωί. Είναι η πρώτη φορά που σου μιλά.");
    expect(describeTime({ now, silenceMin: 3, sessionMin: 3, previous: null })).not.toContain("προηγούμενη κουβέντα");
  });
});
