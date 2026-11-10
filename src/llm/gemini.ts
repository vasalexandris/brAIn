import type { ChatMessage, LlmProvider } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiOptions {
  apiKey: string;
  model: string;
  fastModel: string;
  embedModel: string;
}

/** Πάροχος Gemini μέσω του REST API (χωρίς SDK). */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  constructor(private opts: GeminiOptions) {}

  private async post(path: string, body: unknown): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
      let res: Response;
      try {
        res = await fetch(`${BASE}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.ok) return res.json();
      const text = await res.text();
      lastError = new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
      // Μόνο τα παροδικά σφάλματα αξίζουν επανάληψη.
      if (res.status !== 429 && res.status < 500) break;
    }
    throw lastError;
  }

  private generationConfig(model: string, extra: Record<string, unknown>) {
    // Στο 2.5 Flash η "σκέψη" είναι ενεργή εξ ορισμού και καθυστερεί· εδώ δεν χρειάζεται.
    const thinking = model.startsWith("gemini-2.5-flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {};
    return { ...extra, ...thinking };
  }

  /**
   * Το Gemini θέλει η συζήτηση να αρχίζει με μήνυμα χρήστη και οι ρόλοι να εναλλάσσονται.
   * Όταν ο εγκέφαλος μιλά δύο φορές στη σειρά (πρωτοβουλία), τα μηνύματα ενώνονται.
   */
  private static contents(messages: ChatMessage[]) {
    const out: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      const last = out[out.length - 1];
      if (!last && role === "model") continue;
      if (last?.role === role) last.parts[0].text += `\n\n${m.content}`;
      else out.push({ role, parts: [{ text: m.content }] });
    }
    return out;
  }

  private static text(data: any): string {
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p: any) => typeof p?.text === "string" && !p.thought)
      .map((p: any) => p.text)
      .join("");
    if (!text) {
      const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? "άγνωστο";
      throw new Error(`Το Gemini δεν επέστρεψε κείμενο (λόγος: ${reason})`);
    }
    return text;
  }

  async generateText(req: { system: string; messages: ChatMessage[]; temperature?: number }): Promise<string> {
    const model = this.opts.model;
    const data = await this.post(`${model}:generateContent`, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: GeminiProvider.contents(req.messages),
      generationConfig: this.generationConfig(model, { temperature: req.temperature ?? 1 }),
    });
    return GeminiProvider.text(data).trim();
  }

  async generateJson(req: { system: string; prompt: string }): Promise<unknown> {
    const model = this.opts.fastModel;
    const data = await this.post(`${model}:generateContent`, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: this.generationConfig(model, { temperature: 0.2, responseMimeType: "application/json" }),
    });
    return JSON.parse(GeminiProvider.text(data));
  }

  /** Αναζήτηση Google μέσα από το Gemini (grounding), με το ίδιο κλειδί. */
  async searchWeb(query: string): Promise<{ titles: string[]; text: string }> {
    const model = this.opts.model;
    const data = await this.post(`${model}:generateContent`, {
      systemInstruction: {
        parts: [
          {
            text: "Είσαι εργαλείο έρευνας. Ψάξε στο διαδίκτυο και ανάφερε τι βρήκες για το ερώτημα: γεγονότα, αριθμούς, ονόματα και ημερομηνίες ακριβώς όπως τα γράφουν οι πηγές. Αν δεν βρεις αυτό που ζητείται, γράψε καθαρά ότι δεν το βρήκες. Μην εικάζεις και μη συμπληρώνεις από μνήμης. Ελληνικά, έως 250 λέξεις, χωρίς σχόλια.",
          },
        ],
      },
      contents: [
        { role: "user", parts: [{ text: `Σημερινή ημερομηνία: ${new Date().toISOString().slice(0, 10)}\nΕρώτημα: ${query}` }] },
      ],
      tools: [{ google_search: {} }],
      generationConfig: this.generationConfig(model, { temperature: 0.1 }),
    });
    const chunks: any[] = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    // Χωρίς πηγές δεν έγινε αναζήτηση: το κείμενο θα ήταν απλώς ό,τι "θυμάται" το μοντέλο.
    if (!chunks.length) throw new Error("Το Gemini απάντησε χωρίς να ψάξει");
    return {
      titles: chunks.map((c) => c?.web?.title).filter((t): t is string => typeof t === "string").slice(0, 8),
      text: GeminiProvider.text(data).trim(),
    };
  }

  async embed(text: string): Promise<number[]> {
    const data = await this.post(`${this.opts.embedModel}:embedContent`, {
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    });
    const values = data?.embedding?.values;
    if (!Array.isArray(values)) throw new Error("Το Gemini δεν επέστρεψε embedding");
    return values;
  }
}
