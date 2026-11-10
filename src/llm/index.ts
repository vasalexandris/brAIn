import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import type { LlmProvider } from "./types";

export type { ChatMessage, LlmProvider } from "./types";

let cached: LlmProvider | undefined;

/** Επιλέγει πάροχο από το περιβάλλον. Νέοι πάροχοι (π.χ. Claude) προστίθενται εδώ. */
export function getLlm(): LlmProvider {
  if (cached) return cached;
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    cached = new GeminiProvider({
      apiKey,
      model,
      fastModel: process.env.GEMINI_FAST_MODEL || model,
      embedModel: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001",
    });
  } else {
    console.warn("[brAIn] Δεν βρέθηκε GEMINI_API_KEY — χρησιμοποιείται το δοκιμαστικό μοντέλο (mock).");
    cached = new MockProvider();
  }
  return cached;
}
