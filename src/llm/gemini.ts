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
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
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
