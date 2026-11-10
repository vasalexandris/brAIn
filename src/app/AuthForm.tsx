"use client";

import Link from "next/link";
import { useState } from "react";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const register = mode === "register";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        window.location.href = "/chat";
        return;
      }
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
    } catch {
      setError("Δεν υπάρχει σύνδεση με τον server.");
    }
    setBusy(false);
  }

  return (
    <div className="auth">
      <form onSubmit={submit}>
        <h1>{register ? "Εγγραφή" : "Σύνδεση"}</h1>
        {register && (
          <label className="field">
            <span>Πώς να σε φωνάζει;</span>
            <input name="name" required maxLength={60} autoComplete="given-name" />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label className="field">
          <span>Κωδικός{register ? " (τουλάχιστον 8 χαρακτήρες)" : ""}</span>
          <input
            name="password"
            type="password"
            required
            minLength={register ? 8 : undefined}
            maxLength={72}
            autoComplete={register ? "new-password" : "current-password"}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {register ? "Δημιουργία λογαριασμού" : "Είσοδος"}
        </button>
        <p className="alt">
          {register ? (
            <>
              Έχεις ήδη λογαριασμό; <Link href="/login">Σύνδεση</Link>
            </>
          ) : (
            <>
              Δεν έχεις λογαριασμό; <Link href="/register">Εγγραφή</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
