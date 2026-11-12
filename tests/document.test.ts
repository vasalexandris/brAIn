import { describe, expect, it } from "vitest";
import { chunk, excerpts } from "@/brain/document";

describe("μεγάλα κείμενα", () => {
  it("κόβει στα όρια των παραγράφων, και σπάει μια τεράστια παράγραφο", () => {
    const text = ["α".repeat(500), "β".repeat(500), "γ".repeat(500), "δ".repeat(2500)].join("\n\n");
    const parts = chunk(text, 1100);
    expect(parts[0]).toBe(`${"α".repeat(500)}\n${"β".repeat(500)}`);
    expect(parts[1]).toBe("γ".repeat(500));
    expect(parts.slice(2).join("").replace(/\n/g, "")).toBe("δ".repeat(2500));
    expect(parts.every((p) => p.length <= 1100)).toBe(true);
    expect(chunk("  \n\n ")).toEqual([]);
  });

  it("ανασύρει τα κομμάτια που αφορούν την ερώτηση, με τη σειρά του κειμένου", () => {
    const filler = (n: number) => `Παράγραφος ${n} με γενικό περιεχόμενο για τη θάλασσα και τα κύματα. `.repeat(18);
    const text = [
      filler(1),
      "Οι φυσητήρες βουτούν σε βάθος 2.250 μέτρων για να κυνηγήσουν καλαμάρια.",
      filler(2),
      filler(3),
      "Η αξιολόγηση των φοιτητών αλλάζει: επιστρέφουν οι προφορικές εξετάσεις.",
      filler(4),
    ].join("\n\n");

    const whales = excerpts(text, "Σε τι βάθος βουτάει ο φυσητήρας;");
    expect(whales).toHaveLength(1);
    expect(whales[0]).toContain("2.250 μέτρων");

    // Άλλη κλίση της ίδιας λέξης ταιριάζει· η σειρά είναι αυτή του κειμένου, όχι της βαθμολογίας.
    const both = excerpts(text, "αξιολόγησης φοιτητή και φυσητήρων", 2);
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("φυσητήρες");
    expect(both[1]).toContain("εξετάσεις");

    expect(excerpts(text, "ποδόσφαιρο πρωτάθλημα")).toEqual([]);
    expect(excerpts(text, "τι;")).toEqual([]);
  });
});
