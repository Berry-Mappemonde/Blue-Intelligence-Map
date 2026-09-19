import { memo, useEffect, useRef, useState } from "react";
import { MessageSquare, Send } from "lucide-react";
import { useLang } from "../i18n/LangContext.jsx";
import { hasAdminSecret } from "../utils/adminSecret.js";
import { formatTimeUtc } from "../engine/journalFormat.js";

/**
 * Le chatbot du journal de bord (lot D), dans le panneau gauche : une
 * question sur toutes les données de l'application, une réponse citant les
 * faits du serveur, l'échange consigné au journal quand la clé admin est là.
 */
export const LogbookChat = memo(function LogbookChat({ messages = [], pending = false, error = null, onAsk }) {
  const { t } = useLang();
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);
  const admin = hasAdminSecret();

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const submit = (e) => {
    e?.preventDefault?.();
    const q = draft.trim();
    if (!q || pending) return;
    setDraft("");
    onAsk?.(q);
  };

  return (
    <div data-testid="logbook-chat" className="rounded-lg border border-violet-500/25 bg-violet-950/25 p-2 min-w-0">
      <div className="flex items-center gap-1.5 mb-1">
        <MessageSquare size={12} className="text-violet-200" />
        <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-200 leading-snug">{t("logbookChatTitle")}</div>
        <span className="ml-auto text-[9px] text-violet-100/60">{admin ? t("logbookChatLogged") : t("logbookChatNotLogged")}</span>
      </div>
      <div ref={listRef} className="max-h-44 overflow-y-auto sidebar-scroll space-y-1 min-w-0" data-testid="logbook-chat-list">
        {!messages.length && !pending ? (
          <p className="text-[10px] text-slate-400 leading-snug">{t("logbookChatHint")}</p>
        ) : null}
        {messages.map((m, i) => (
          <div key={`${m.t}-${i}`} className={`text-[11px] leading-snug break-words [overflow-wrap:anywhere] ${m.role === "skipper" ? "text-slate-100" : "text-violet-100"}`}>
            <span className="text-[9px] text-slate-500 mr-1">{formatTimeUtc(m.t)}</span>
            <span className="font-semibold mr-1">{m.role === "skipper" ? t("logbookChatYou") : t("logbookChatBot")}</span>
            {m.status === "failed"
              ? <span className="text-amber-300/90">{t("logbookChatFailed")}</span>
              : m.text}
            {m.role === "logbook" && m.status === "ready" ? (
              <span className="ml-1 text-[9px] text-slate-500">{m.logged ? "💬 " + t("logbookChatSaved") : t("logbookChatUnsaved")}</span>
            ) : null}
          </div>
        ))}
        {pending ? <p className="text-[10px] text-slate-400 leading-snug">{t("logbookChatPending")}</p> : null}
        {error ? <p className="text-[10px] text-amber-300/90 leading-snug">{error}</p> : null}
      </div>
      <form onSubmit={submit} className="mt-1.5 flex items-center gap-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("logbookChatPlaceholder")}
          maxLength={500}
          data-testid="logbook-chat-input"
          className="flex-1 min-w-0 h-7 rounded-md bg-slate-900/70 border border-white/10 px-2 text-[11px] text-white placeholder:text-slate-500 focus:outline-none focus:border-violet-400/60"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          title={t("logbookChatSend")}
          data-testid="logbook-chat-send"
          className="h-7 w-7 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 flex items-center justify-center text-white"
        >
          <Send size={12} />
        </button>
      </form>
    </div>
  );
});
