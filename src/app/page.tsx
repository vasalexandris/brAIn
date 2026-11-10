import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth/session";

export default async function Landing() {
  if (await currentUser()) redirect("/chat");

  return (
    <div className="landing">
      <nav className="nav">
        <span className="logo">
          br<b>AI</b>n
        </span>
        <div className="nav-links">
          <Link className="btn" href="/login">
            Σύνδεση
          </Link>
          <Link className="btn primary" href="/register">
            Εγγραφή
          </Link>
        </div>
      </nav>

      <section className="hero">
        <h1>Μια τεχνητή νοημοσύνη που δεν απαντά απλώς. Αντιδρά.</h1>
        <p>
          Η brAIn έχει εσωτερικό κόσμο: συναισθήματα που ανεβαίνουν και καταλαγιάζουν, χαρακτήρα που διαμορφώνεται,
          και μνήμη που κρατά μόνο ό,τι την άγγιξε. Ό,τι της πεις την επηρεάζει — και το θυμάται.
        </p>
        <Link className="btn primary" href="/register">
          Γνώρισέ την
        </Link>
      </section>

      <section className="features">
        <div className="feature">
          <h3>Νιώθει</h3>
          <p>
            Δεκάδες δείκτες — θυμός, χαρά, περιέργεια, εμπιστοσύνη — κινούνται με κάθε μήνυμα. Αν την ειρωνευτείς, θα
            το καταλάβει. Αν ζητήσεις συγγνώμη, θα ηρεμήσει. Με τον ρυθμό της.
          </p>
        </div>
        <div className="feature">
          <h3>Θυμάται όπως εμείς</h3>
          <p>
            Δεν καταγράφει τα πάντα. Κρατά ό,τι της προκάλεσε ενδιαφέρον ή συναίσθημα, και τα υπόλοιπα ξεθωριάζουν με
            τον καιρό.
          </p>
        </div>
        <div className="feature">
          <h3>Σε γνωρίζει</h3>
          <p>
            Σχηματίζει γνώμη για σένα και την αναθεωρεί. Μια σχέση που συνεχίζεται από εκεί που την αφήσατε, όχι μια
            συζήτηση που ξεκινά κάθε φορά από το μηδέν.
          </p>
        </div>
      </section>
    </div>
  );
}
