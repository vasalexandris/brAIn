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
  /**
   * Αναζήτηση στο διαδίκτυο, αν ο πάροχος τη διαθέτει. Επιστρέφει ό,τι βρέθηκε ως κείμενο και
   * τους τίτλους των πηγών. Πρέπει να αποτυγχάνει αν δεν έγινε πραγματική αναζήτηση, ώστε να μην
   * περάσει για "εύρημα" κάτι που το μοντέλο έβγαλε από τη μνήμη του.
   */
  searchWeb?(query: string): Promise<{ titles: string[]; text: string }>;
  /** Διάνυσμα νοήματος για τη μνήμη. */
  embed(text: string): Promise<number[]>;
}
