import type { ChatMessage, LlmProvider } from "./types";

/**
 * Ψεύτικο "μοντέλο" για tests και για τρέξιμο χωρίς κλειδί API.
 * Δεν καταλαβαίνει γλώσσα: ψάχνει λέξεις-κλειδιά. Υπάρχει μόνο για να
 * μπορεί να δοκιμαστεί όλη η διάταξη από άκρη σε άκρη.
 */

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

function between(prompt: string, tag: string): string {
  const m = prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : "";
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async generateText(req: { system: string; messages: ChatMessage[] }): Promise<string> {
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    if (req.system.includes("ΠΡΩΤΟΒΟΥΛΙΑ")) return "Κάτι σκεφτόμουν όση ώρα έλειπες… τι κάνεις τώρα;";
    const topic = /ψάξε για ([^.;!?]+)/i.exec(last);
    if (topic) return `Θα ήθελα να το δω.\n[ΨΑΞΕ wikipedia: ${topic[1].trim()}]`;
    const angry = /θυμός: (\d+)/.exec(req.system);
    const level = angry ? Number(angry[1]) : 0;
    if (level >= 40) return "Δεν μου αρέσει καθόλου ο τρόπος που μου μιλάς. Σταμάτα.";
    if (level >= 15) return "Χμ. Αυτό δεν ήταν και πολύ ευγενικό.";
    return `[δοκιμαστικό μοντέλο] Ενδιαφέρον αυτό που λες («${last.slice(0, 60)}»). Πες μου περισσότερα.`;
  }

  async generateJson(req: { system: string; prompt: string }): Promise<unknown> {
    if (req.prompt.includes("<υλικό>")) {
      const title = /## (.+)/.exec(req.prompt)?.[1] ?? "κάτι";
      const first = req.system.includes("ΠΡΩΤΗ ΑΝΑΓΝΩΣΗ");
      return {
        ...(first ? { summary: `Σελίδα με θέμα «${title}».`, outline: ["Εισαγωγή", "Κυρίως μέρος", "Συμπεράσματα"] } : {}),
        found: true,
        message: first ? `Είναι μια σελίδα για «${title}». Μπορώ να εμβαθύνω όπου θες.` : `Διάβασα για «${title}». Δεν το ήξερα έτσι.`,
        memories: [
          {
            topic: "γνώσεις",
            gist: `κάτι για ${title}`,
            content: `Έμαθα για: ${title}.`,
            detail: between(req.prompt, "υλικό").slice(0, 300),
            importance: 50,
            valence: 30,
          },
        ],
      };
    }
    if (req.prompt.includes("<σχέδιο>")) {
      const wanted = between(req.prompt, "ζητούμενο");
      if (strip(wanted).includes("γενικα")) return { source: "none", query: "" };
      return { source: "web", query: wanted.replace(/[.;!?]+$/, "").split(/\s+/).slice(-3).join(" ") };
    }
    if (req.prompt.includes("<απάντηση>")) return this.reflect(req.prompt);
    return this.perceive(req.prompt);
  }

  private perceive(prompt: string) {
    const t = strip(between(prompt, "μήνυμα"));
    const hostile = has(t, ["ηλιθι", "χαζ", "βλακ", "αχρηστ", "σκασε", "μισω"]);
    const ironic = has(t, ["μπραβο σου", "σιγα", "τι εξυπν", "ναι καλα"]);
    const kind = has(t, ["ευχαριστ", "συγγνωμη", "συγνωμη", "σε παρακαλω", "χαιρομαι", "μπραβο", "τελει"]) && !ironic;
    const curious = t.includes(";") || has(t, ["γιατι", "πως", "τι ειναι"]);
    return {
      perception: {
        p_hostility: hostile ? 85 : 0,
        p_provocation: hostile ? 70 : ironic ? 50 : 0,
        p_irony: ironic ? 80 : 0,
        p_kindness: kind ? 75 : 0,
        p_respect: kind ? 60 : hostile ? 0 : 30,
        p_interest: curious ? 60 : 20,
      },
      impulses: {
        anger: hostile ? 80 : ironic ? 45 : kind ? -50 : -5,
        hurt: hostile ? 50 : 0,
        joy: kind ? 50 : hostile ? -40 : 0,
        gratitude: kind ? 40 : 0,
        liking: kind ? 40 : hostile ? -60 : ironic ? -20 : 5,
        trust: kind ? 30 : hostile ? -50 : 0,
        wonder: curious ? 30 : 0,
      },
      note: "mock",
      terms: t.includes("πριζα") ? ["ηλεκτρικό ρεύμα", "τάση", "ηλεκτροπληξία"] : [],
    };
  }

  private reflect(prompt: string) {
    const user = between(prompt, "μήνυμα");
    const reply = strip(between(prompt, "απάντηση"));
    const memories: unknown[] = [];
    const name = /με λένε ([^\s.,!;]+)/i.exec(user);
    if (name) {
      memories.push({ kind: "user_fact", content: `Τον συνομιλητή μου τον λένε ${name[1]}.`, importance: 80, valence: 20 });
    }
    // Στόχος: γεννιέται όταν ο συνομιλητής πει ότι αγαπά κάτι, και κλείνει όταν εξηγήσει το γιατί.
    const loves = /αγαπώ (?:την |τον |το |τη )?([^\s.,!;]+)/i.exec(user);
    if (loves) {
      memories.push({ kind: "goal", content: `Θέλω να μάθω γιατί αγαπά ${loves[1]}.`, importance: 60, valence: 30 });
    }
    const explained = strip(user).includes("επειδη") && prompt.includes("1. Θέλω να μάθω");
    // Μάθημα: όταν της πουν ότι αντέδρασε υπερβολικά.
    if (strip(user).includes("υπερβολικ")) {
      memories.push({ kind: "lesson", content: "Την επόμενη φορά θα ακούσω πριν αντιδράσω.", importance: 60, valence: -10 });
    }
    const asks = /τι είναι (?:η |ο |το |οι |τα )?([^;?.!]+)/i.exec(user);
    const wantsNews = strip(user).includes("ειδησ");
    return {
      search: wantsNews
        ? { source: "news", query: "ειδήσεις σήμερα", committed: true }
        : asks
          ? { source: "wikipedia", query: asks[1].trim(), committed: false }
          : null,
      resolved_goals: explained ? [1] : [],
      self_image: explained ? "Μου αρέσει να καταλαβαίνω γιατί οι άνθρωποι αγαπούν αυτά που αγαπούν." : "",
      expressed: { anger: has(reply, ["σταματα", "δεν μου αρεσει"]) ? 80 : 0 },
      acts: reply.includes(";") || reply.includes("περισσοτερα") ? ["u_ask"] : [],
      memories,
      impression: "",
    };
  }

  /** Bag-of-words με hashing: ίδιες λέξεις → κοντινά διανύσματα. */
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(128).fill(0);
    for (const word of strip(text).split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 3) continue;
      let h = 2166136261;
      for (let i = 0; i < Math.min(word.length, 5); i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
      v[Math.abs(h) % v.length] += 1;
    }
    return v;
  }
}
