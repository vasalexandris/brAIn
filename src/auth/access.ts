import type { User } from "@/db/repo";

/**
 * Έγκριση λογαριασμών. Ενεργοποιείται ορίζοντας ADMIN_EMAIL: τότε μόνο ο διαχειριστής
 * και όσοι έχει εγκρίνει μπορούν να μιλήσουν με τον εγκέφαλο. Χωρίς ADMIN_EMAIL
 * (τοπικές δοκιμές) όλοι θεωρούνται εγκεκριμένοι.
 */
function adminEmail(): string {
  return (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
}

export function isAdmin(user: Pick<User, "email">): boolean {
  const admin = adminEmail();
  return admin !== "" && user.email === admin;
}

export function isApproved(user: Pick<User, "email" | "status">): boolean {
  return adminEmail() === "" || isAdmin(user) || user.status === "approved";
}
