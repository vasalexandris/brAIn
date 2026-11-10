/**
 * Ένας γύρος τη φορά ανά χρήστη: δύο ταυτόχρονες επεξεργασίες θα έγραφαν η μία πάνω
 * στην κατάσταση της άλλης. (Ισχύει ανά διεργασία· για πολλούς servers θα χρειαστεί
 * κλείδωμα στη βάση.)
 */
const holder = globalThis as unknown as { __brainBusy?: Set<string> };
export const busy: Set<string> = (holder.__brainBusy ??= new Set());
