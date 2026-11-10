"use client";

import { useState } from "react";

type Status = "pending" | "approved" | "rejected";
interface Row {
  id: string;
  name: string;
  email: string;
  status: Status;
  created: string;
}

const LABELS: Record<Status, string> = { pending: "Σε αναμονή", approved: "Εγκεκριμένος", rejected: "Απορρίφθηκε" };

export function Users({ users }: { users: Row[] }) {
  const [rows, setRows] = useState(users);
  const [error, setError] = useState("");

  async function setStatus(id: string, status: Status) {
    setError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("Η αλλαγή δεν αποθηκεύτηκε. Δοκίμασε ξανά.");
      return;
    }
    setRows((r) => r.map((u) => (u.id === id ? { ...u, status } : u)));
  }

  const order: Status[] = ["pending", "approved", "rejected"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="admin">
      <header className="nav">
        <span className="logo">
          br<b>AI</b>n · Διαχείριση
        </span>
        <a className="btn" href="/chat">
          Πίσω στη συνομιλία
        </a>
      </header>
      {error && <p className="error">{error}</p>}
      {sorted.length === 0 ? (
        <p className="empty">Δεν έχει εγγραφεί κανείς άλλος ακόμη.</p>
      ) : (
        <ul className="user-list">
          {sorted.map((u) => (
            <li key={u.id}>
              <div className="user-info">
                <strong>{u.name}</strong>
                <span>{u.email}</span>
                <span>
                  Εγγραφή {u.created} · <em className={`status ${u.status}`}>{LABELS[u.status]}</em>
                </span>
              </div>
              <div className="user-actions">
                {u.status !== "approved" && (
                  <button className="btn primary" onClick={() => setStatus(u.id, "approved")}>
                    Έγκριση
                  </button>
                )}
                {u.status !== "rejected" && (
                  <button className="btn" onClick={() => setStatus(u.id, "rejected")}>
                    {u.status === "approved" ? "Ανάκληση" : "Απόρριψη"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
