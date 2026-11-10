"use client";

import { useEffect, useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}
interface Debug {
  note: string;
  recalled: string[];
  stored: string[];
  impression: string;
  selfImage: string;
  goals: string[];
  lessons?: string[];
}
interface Proposal {
  id: string;
  sourceLabel: string;
  query: string;
}
interface Props {
  initialSearch: Proposal | null;
  initialMessages: Msg[];
  initialValues: Record<string, number>;
  initialImpression: string;
  initialSelfImage: string;
  dimensions: { key: string; label: string; category: string }[];
  categories: Record<string, string>;
  admin: boolean;
}

export function Chat({ initialMessages, initialValues, initialImpression, initialSelfImage, initialSearch, dimensions, categories, admin }: Props) {
  const [messages, setMessages] = useState(initialMessages);
  const [values, setValues] = useState(initialValues);
  const [debug, setDebug] = useState<Debug>({
    note: "",
    recalled: [],
    stored: [],
    impression: initialImpression,
    selfImage: initialSelfImage,
    goals: [],
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inspect, setInspect] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(initialSearch);
  const bottom = useRef<HTMLDivElement>(null);

  // Σφυγμός: όσο σωπαίνεις, ρωτάμε τον server πότε θα "αντέξει" τη σιωπή — και αν μίλησε πρώτη.
  const live = useRef({ busy, typing: false });
  live.current = { busy, typing: text.trim() !== "" };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = useRef<(sec: number) => void>(() => {});
  schedule.current = (sec: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // Δεν διακόπτει όσο γράφεις ή όσο η καρτέλα είναι κρυμμένη.
      if (live.current.busy || live.current.typing || document.visibilityState !== "visible") {
        schedule.current(20);
        return;
      }
      try {
        const res = await fetch("/api/pulse", { method: "POST" });
        const body = res.ok ? await res.json() : null;
        if (body?.message) {
          setMessages((m) => [...m, { role: "assistant", content: body.message }]);
          setValues(body.values);
        }
        if (typeof body?.nextInSec === "number") schedule.current(Math.min(Math.max(body.nextInSec, 15), 1800));
      } catch {
        schedule.current(120);
      }
    }, sec * 1000);
  };
  useEffect(() => {
    schedule.current(3);
    return () => clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, proposal]);

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setText("");
    setError("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !body?.reply) throw new Error(body?.error ?? "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
      setMessages((m) => [...m, { role: "assistant", content: body.reply }]);
      setValues(body.values);
      setDebug(body.debug);
      setProposal(body.search ?? null);
      schedule.current(45);
    } catch (err) {
      // Το μήνυμα δεν αποθηκεύτηκε: το επιστρέφουμε στο πεδίο για να ξανασταλεί.
      setMessages((m) => m.slice(0, -1));
      setText(message);
      setError(err instanceof Error ? err.message : "Κάτι πήγε στραβά.");
    }
    setBusy(false);
  }

  async function answerSearch(approve: boolean) {
    if (!proposal || busy) return;
    const current = proposal;
    setProposal(null);
    setError("");
    if (approve) setBusy(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: current.id, approve }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Κάτι πήγε στραβά.");
      if (body.message) setMessages((m) => [...m, { role: "assistant", content: body.message }]);
      setValues(body.values);
      if (body.stored?.length) setDebug((d) => ({ ...d, stored: body.stored }));
      schedule.current(45);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Κάτι πήγε στραβά.");
    }
    setBusy(false);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  return (
    <div className="chat">
      <div className="chat-main">
        <header className="chat-head">
          <span className="logo">
            br<b>AI</b>n
          </span>
          <div className="chat-actions">
            {admin && (
              <a className="btn" href="/admin">
                Διαχείριση
              </a>
            )}
            <button className="btn" onClick={() => setInspect((v) => !v)} aria-pressed={inspect}>
              {inspect ? "Κλείσιμο" : "Εσωτερική κατάσταση"}
            </button>
            <button className="btn" onClick={logout}>
              Έξοδος
            </button>
          </div>
        </header>

        <div className="messages">
          <div className="messages-inner">
            {messages.length === 0 && !busy && <p className="empty">Πες της κάτι. Δεν σε ξέρει ακόμη.</p>}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.content}
              </div>
            ))}
            {proposal && !busy && (
              <div className="proposal">
                <span>
                  Θέλει να ψάξει ({proposal.sourceLabel}): <strong>{proposal.query}</strong>
                </span>
                <div>
                  <button className="btn primary" onClick={() => answerSearch(true)}>
                    Να ψάξει
                  </button>
                  <button className="btn" onClick={() => answerSearch(false)}>
                    Όχι τώρα
                  </button>
                </div>
              </div>
            )}
            {busy && <div className="bubble assistant pending">σκέφτεται…</div>}
            <div ref={bottom} />
          </div>
        </div>

        <div className="composer">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              rows={1}
              value={text}
              placeholder="Γράψε ένα μήνυμα…"
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="btn primary" disabled={busy || !text.trim()}>
              Αποστολή
            </button>
          </form>
          {error && (
            <p className="error" style={{ maxWidth: 720, margin: "8px auto 0" }}>
              {error}
            </p>
          )}
        </div>
      </div>

      {inspect && (
        <aside className="inspector">
          <h4>Τι κατάλαβε</h4>
          <p>{debug.note || "—"}</p>
          <h4>Εντύπωση για σένα</h4>
          <p>{debug.impression || "—"}</p>
          <h4>Πώς βλέπει τον εαυτό της</h4>
          <p>{debug.selfImage || "—"}</p>
          <h4>Οι στόχοι της</h4>
          {debug.goals.length ? <ul>{debug.goals.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p>—</p>}
          <h4>Τι έμαθε για τον εαυτό της</h4>
          {debug.lessons?.length ? <ul>{debug.lessons.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p>—</p>}
          <h4>Τι της ήρθε στο μυαλό</h4>
          {debug.recalled.length ? <ul>{debug.recalled.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p>—</p>}
          <h4>Τι κράτησε στη μνήμη</h4>
          {debug.stored.length ? <ul>{debug.stored.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p>—</p>}
          {Object.entries(categories).map(([cat, title]) => (
            <div key={cat}>
              <h4>{title}</h4>
              {dimensions
                .filter((d) => d.category === cat)
                .map((d) => (
                  <div className="dim" key={d.key}>
                    <span>{d.label}</span>
                    <span className="track">
                      <span className="fill" style={{ width: `${values[d.key] ?? 0}%`, display: "block" }} />
                    </span>
                    <span className="num">{Math.round(values[d.key] ?? 0)}</span>
                  </div>
                ))}
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}
