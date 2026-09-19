import { useCallback, useRef, useState } from "react";
import { adminHeaders } from "../utils/adminSecret.js";

const API_URL = import.meta.env.VITE_API_URL ?? "";
const HISTORY_MAX = 30;

/**
 * Chatbot journal de bord (lot D). `ask(question)` posts to /logbook/chat with
 * the facts only the client knows (`contextFn()` → view, boat of the film,
 * polar, skipper's orders). The server answers from its own facts and logs
 * the exchange when the admin key travels with the request. Never blocks
 * Play; one question in flight at a time.
 */
export function useLogbookChat({ lang = "fr", contextFn = null } = {}) {
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);

  const ask = useCallback(async (question) => {
    const q = String(question || "").trim();
    if (!q || inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const t = new Date().toISOString();
    setMessages((prev) => [...prev, { role: "skipper", text: q, t }].slice(-HISTORY_MAX));
    let context = null;
    try {
      context = typeof contextFn === "function" ? contextFn() : null;
    } catch {
      context = null;
    }
    try {
      const r = await fetch(`${API_URL}/logbook/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ question: q, lang, context }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail || `HTTP ${r.status}`);
      const reply = {
        role: "logbook",
        text: body.answer || "",
        status: body.status,
        reason: body.reason || null,
        logged: Boolean(body.logged),
        engine: body.engine || null,
        t: body.t || new Date().toISOString(),
      };
      setMessages((prev) => [...prev, reply].slice(-HISTORY_MAX));
      return reply;
    } catch (err) {
      setError(err?.message || "error");
      return null;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [lang, contextFn]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, pending, error, ask, clear };
}
