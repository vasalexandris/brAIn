/** Αφαίρεση παρόχου: ο εγκέφαλος δεν ξέρει ποιο μοντέλο υπάρχει από πίσω. */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  readonly name: string;
  /** Ελεύθερο κείμενο: η φωνή του εγκεφάλου. */
  generateText(req: { system: string; messages: ChatMessage[]; temperature?: number }): Promise<string>;
  /** Δομημένη έξοδος JSON: αντίληψη και αναστοχασμός (γρήγορο μοντέλο). */
  generateJson(req: { system: string; prompt: string }): Promise<unknown>;
  /** Διάνυσμα νοήματος για τη μνήμη. */
  embed(text: string): Promise<number[]>;
}
