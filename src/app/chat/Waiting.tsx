"use client";

export function Waiting({ name, rejected }: { name: string; rejected: boolean }) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }
  return (
    <div className="auth">
      <form onSubmit={(e) => e.preventDefault()}>
        <h1>{rejected ? "Ο λογαριασμός δεν εγκρίθηκε" : `Σχεδόν έτοιμα, ${name}`}</h1>
        <p style={{ color: "var(--muted)", margin: "0 0 16px" }}>
          {rejected
            ? "Ο διαχειριστής δεν ενέκρινε την πρόσβασή σου."
            : "Ο λογαριασμός σου δημιουργήθηκε και περιμένει έγκριση από τον διαχειριστή. Μόλις εγκριθεί, θα μπορείς να μπεις από εδώ."}
        </p>
        {!rejected && (
          <button className="btn primary" onClick={() => window.location.reload()}>
            Έλεγχος ξανά
          </button>
        )}
        <button className="btn" onClick={logout}>
          Έξοδος
        </button>
      </form>
    </div>
  );
}
