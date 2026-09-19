import { memo, useEffect, useState } from "react";
import { CheckCircle, ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useLang } from "../i18n/LangContext.jsx";
import { SimulationPanel } from "./SimulationPanel";
import { JournalPanel } from "./JournalPanel.jsx";
import { FreeMomentBlock, MomentNowCard } from "./MomentCards.jsx";
import { EscaleSheet } from "./EscaleSheet.jsx";
import { LogbookChat } from "./LogbookChat.jsx";
import { VIEW_SIMULATION, VIEW_SUIVRE } from "../constants/viewMode.js";
import { canFocus, entityLinks } from "../engine/briefingLinks.js";

const NAVIGUIDE_LOGO = "/logo-naviguide.png";
const BERRY_LOGO = "/logo-berry-mappemonde.png";

function BerryCard({
  onCustomRoute, onRouteSwitchToBerry, isDrawing,
  onDrawStart, onDrawContinue, onDrawFinish, onDrawCancel, onCustomDelete, canContinueDraw,
  canFinishDraw = true,
}) {
  const { t } = useLang();
  const [cardMode, setCardMode] = useState("berry-active");
  const [drawnRoute, setDrawnRoute] = useState(null);
  const [drawnName, setDrawnName] = useState(null);
  const hasCustom = Boolean(drawnRoute);
  const customOn = cardMode === "file-active";

  useEffect(() => {
    if (!isDrawing && cardMode === "draw-mode") {
      setCardMode(hasCustom ? "berry-active-file-loaded" : "berry-active");
    }
  }, [isDrawing, cardMode, hasCustom]);

  const activateBerry = () => {
    setCardMode(hasCustom ? "berry-active-file-loaded" : "berry-active");
    onRouteSwitchToBerry();
  };

  const activateCustom = () => {
    if (!drawnRoute) return;
    setCardMode("file-active");
    onCustomRoute(drawnRoute);
  };

  const handleFinishDrawing = () => {
    const geojson = onDrawFinish();
    if (geojson?.features?.length > 0) {
      setDrawnRoute(geojson);
      setDrawnName(t("customRoute"));
      setCardMode("file-active");
      onCustomRoute(geojson);
    } else {
      setCardMode(hasCustom ? "berry-active-file-loaded" : "berry-active");
    }
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    setDrawnRoute(null);
    setDrawnName(null);
    setCardMode("berry-active");
    onCustomDelete?.();
    onRouteSwitchToBerry();
  };

  const pillOn = "flex-1 min-w-0 px-2 py-1.5 rounded-lg text-[10px] font-semibold leading-tight border border-blue-400/60 bg-blue-600/30 text-blue-100";
  const pillOff = "flex-1 min-w-0 px-2 py-1.5 rounded-lg text-[10px] font-semibold leading-tight border border-slate-600/50 bg-slate-800/50 text-slate-400 hover:text-white hover:border-slate-500";

  const switcher = hasCustom ? (
    <div className="flex gap-1 mb-1.5">
      <button type="button" onClick={activateBerry} className={customOn ? pillOff : pillOn} title={t("backToBerry")}>
        {t("berryMappemonde")} {/* pragma: allowlist secret */}
      </button>
      <button type="button" onClick={activateCustom} className={customOn ? pillOn : pillOff} title={t("showRoute", { name: drawnName })}>
        {drawnName || t("customRoute")}
      </button>
    </div>
  ) : null;

  if (cardMode === "draw-mode" || isDrawing) {
    return (
      <div className="rounded-lg px-2 py-1.5 border border-slate-700/50 bg-slate-800/60">
        {switcher}
        {isDrawing ? (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setCardMode(hasCustom ? "berry-active-file-loaded" : "berry-active");
                onDrawCancel?.();
              }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-slate-700/40 hover:bg-slate-700/70
                border border-slate-500/50 rounded-lg px-2 py-1.5 text-[10px] text-slate-200 font-semibold"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleFinishDrawing}
              disabled={!canFinishDraw}
              className="flex-1 flex items-center justify-center gap-1.5 bg-green-600/30 hover:bg-green-600/50
                border border-green-500/50 rounded-lg px-2 py-1.5 text-[10px] text-green-300 font-semibold
                disabled:opacity-40 disabled:pointer-events-none"
            >
              <CheckCircle size={11} /> {t("finish")}
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setCardMode("draw-mode"); onDrawStart(); }}
            className="w-full flex items-center justify-center gap-1.5 bg-violet-600/20 hover:bg-violet-600/40
              border border-violet-500/40 rounded-lg px-2 py-1.5 text-[10px] text-violet-300 font-medium"
          >
            <Pencil size={11} /> {t("drawOwnRoute")}
          </button>
        )}
      </div>
    );
  }

  if (cardMode === "file-active") {
    return (
      <div className="rounded-lg px-2 py-1.5 border border-blue-500/70 bg-blue-950/30">
        {switcher}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => { setCardMode("draw-mode"); (canContinueDraw ? onDrawContinue : onDrawStart)?.(); }}
            className="flex-1 flex items-center justify-center gap-1 px-1.5 py-1 rounded-lg text-[10px]
              font-medium border border-violet-500/40 text-violet-300 hover:bg-violet-600/20"
          >
            <Pencil size={10} /> {canContinueDraw ? t("continueDrawing") : t("drawOwnRoute")}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            title={t("deleteCustomRoute")}
            className="flex items-center justify-center px-2 py-1 rounded-lg text-[10px]
              border border-red-500/40 text-red-300 hover:bg-red-600/20"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg px-2 py-1.5 border border-blue-500/70 bg-blue-950/30">
      {switcher}
      <button
        onClick={() => { setCardMode("draw-mode"); onDrawStart(); }}
        title={t("drawOwnRoute")}
        className="w-full flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-blue-900/30 cursor-pointer"
      >
        <img src={BERRY_LOGO} alt="Berry-Mappemonde" className="h-7 w-auto object-contain rounded flex-shrink-0" style={{ maxWidth: 48 }} /> {/* pragma: allowlist secret */}
        <div className="text-left">
          <div className="text-white font-bold text-[11px] leading-tight tracking-wide">{t("berryMappemonde")}</div> {/* pragma: allowlist secret */}
          <div className="text-[10px] text-violet-300">{t("drawOwnRoute")}</div>
        </div>
      </button>
    </div>
  );
}

/**
 * Briefing with links. Each place the bag named:
 *   - the name → "voir sur la carte" (layer on + fit boat & place), when it has coordinates
 *   - ↗ → official sheet (Sextant, douane, marina site…) when the bag has a URL
 *   - ◎ → Google Maps sheet, for real places (marinas, ports, anchorages, AtoN, PoE)
 * Plain text is untouched: segments joined === narrateIci().
 */
function BriefingText({ segments, onFocus, t }) {
  return segments.map((seg, i) => {
    if (!seg.entity) return <span key={i}>{seg.text}</span>;
    const e = seg.entity;
    const links = entityLinks(e);
    const focusable = canFocus(e) && typeof onFocus === "function";
    return (
      <span key={i} className="inline whitespace-nowrap" data-testid="briefing-entity" data-kind={e.kind}>
        {focusable ? (
          <button
            type="button"
            onClick={() => onFocus(e)}
            title={t("briefingSeeOnMap")}
            className="inline text-sky-200 underline decoration-dotted decoration-sky-400/70 underline-offset-2 hover:text-white whitespace-normal text-left"
          >
            {seg.text}
          </button>
        ) : (
          <span className="text-slate-200">{seg.text}</span>
        )}
        {links.map((l) => (
          <a
            key={l.kind}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            title={l.kind === "site" ? `${t("briefingOfficialSheet")} — ${l.host || ""}` : t("briefingGoogleMaps")}
            aria-label={l.kind === "site" ? t("briefingOfficialSheet") : t("briefingGoogleMaps")}
            data-testid={`briefing-link-${l.kind}`}
            className="ml-0.5 text-[10px] text-sky-300/80 hover:text-white align-baseline no-underline"
          >
            {l.kind === "site" ? "↗" : "◎"}
          </a>
        ))}
      </span>
    );
  });
}

export const Sidebar = memo(function Sidebar({
  plan, open, onToggle, onCustomRoute, onRouteSwitchToBerry, isDrawing,
  onDrawStart, onDrawContinue, onDrawFinish, onDrawCancel, onCustomDelete, canContinueDraw,
  canFinishDraw,
  isCockpit, polarData, view = VIEW_SUIVRE,
  legContext, briefingLoading, officialFallback,
  iciBriefing = null,
  iciBriefingSegments = null, onBriefingFocus,
  skipperNotice = null,
  clockSample = null, atQuay = false, quayDays = 0,
  previewing = false, forecastStatus = null,
  onRecompute, canRecompute = false, recomputeBusy = false, onGoLive,
  journal = null, journalLoading = false, journalError = null,
  story = null,
  momentNow = null, momentNowLeft = 0, onMomentDismiss,
  momentFree = null, momentFreeLeft = 0, onMomentNext,
  escaleStop = null, escaleSheet = null, onEscaleClose,
  chat = null, onChatAsk,
}) {
  const { t } = useLang();
  const isSimulation = view === VIEW_SIMULATION;
  const isSuivre = view === VIEW_SUIVRE;
  const expeditionBriefing = plan?.executive_briefing || "";
  const briefing = iciBriefing || expeditionBriefing;
  const briefingTitle = !iciBriefing && typeof plan?.briefing_title === "string"
    ? plan.briefing_title.trim()
    : "";

  return (
    <>
      <button
        onClick={onToggle}
        className={`naviguide-sidebar-toggle naviguide-sidebar-toggle--left absolute z-30 bg-slate-900/95 text-white
          rounded-full flex items-center justify-center shadow-lg
          hover:bg-slate-800 transition-all duration-300
          w-9 h-9 border border-slate-700
          ${open ? "left-[322px] top-4" : "left-4 top-[92px]"}`}
        title={open ? t("hideSidebar") : t("showExpeditionPanel")}
      >
        {open ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      <div
        className={`naviguide-sidebar-panel absolute top-0 left-0 h-full z-20 flex flex-col bg-slate-900/97
          shadow-2xl transition-transform duration-300 border-r border-slate-700/60
          ${open ? "translate-x-0" : "-translate-x-full"}`}
        style={{ width: 320 }}
      >
        <div className="px-2.5 pt-1.5 pb-1.5 border-b border-slate-700/60 flex-shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <img src={NAVIGUIDE_LOGO} alt={t("brandTitle")} className="h-9 w-9 object-contain drop-shadow" />
            <span className="text-white font-bold text-[11px] leading-tight tracking-wide">{t("brandTitle")}</span>
          </div>

          <BerryCard
            onCustomRoute={onCustomRoute}
            onRouteSwitchToBerry={onRouteSwitchToBerry}
            isDrawing={isDrawing}
            onDrawStart={onDrawStart}
            onDrawContinue={onDrawContinue}
            onDrawFinish={onDrawFinish}
            onDrawCancel={onDrawCancel}
            onCustomDelete={onCustomDelete}
            canContinueDraw={canContinueDraw}
            canFinishDraw={canFinishDraw}
          />
        </div>

        {/* ── Le produit « ici » : où on est, ce qui se passe, ce qu’il y a autour ── */}
        <div className="flex-1 overflow-y-auto sidebar-scroll px-2.5 py-1.5 space-y-1.5" data-testid="here-product">
          {!isCockpit && !plan && !briefingLoading && !isDrawing && (
            <div className="rounded-lg border border-blue-700/30 bg-blue-950/20 p-2">
              <div className="text-[10px] font-semibold text-blue-300 mb-1">{t("gettingStarted")}</div>
              <p className="text-[11px] text-slate-400 leading-snug">{t("gettingStartedText")}</p>
            </div>
          )}

          {isDrawing && (
            <div className="bg-slate-800/50 rounded-lg p-2 border border-slate-700/50">
              <p className="text-[11px] text-slate-300 leading-snug whitespace-pre-line">{t("briefingDrawHint")}</p>
            </div>
          )}

          {!isDrawing ? (
            <SimulationPanel
              legContext={legContext}
              clockSample={clockSample}
              kindLabel=""
              atQuay={atQuay}
              quayDays={quayDays}
              liveFollow={isSuivre}
              previewing={previewing}
              forecastStatus={isSuivre ? forecastStatus : null}
              onRecompute={onRecompute}
              canRecompute={canRecompute}
              showRecompute={isSimulation}
              recomputeBusy={recomputeBusy}
              onGoLive={onGoLive}
            />
          ) : null}

          {!isDrawing && momentNow ? (
            <MomentNowCard card={momentNow} left={momentNowLeft} onDismiss={onMomentDismiss} onFocus={onBriefingFocus} inline />
          ) : null}
          {!isDrawing && momentFree ? (
            <FreeMomentBlock card={momentFree} left={momentFreeLeft} onNext={onMomentNext} onFocus={onBriefingFocus} inline />
          ) : null}

          {!isDrawing && escaleStop ? (
            <EscaleSheet
              stop={escaleStop}
              fiche={escaleSheet?.fiche}
              loading={Boolean(escaleSheet?.loading)}
              error={escaleSheet?.error}
              onClose={onEscaleClose}
              onFocus={onBriefingFocus}
            />
          ) : null}

          {!isDrawing && (isCockpit || briefing || briefingLoading || skipperNotice) && (
            <div className="bg-slate-800/50 rounded-lg p-2 border border-slate-700/50 min-w-0 overflow-x-hidden">
              {briefingTitle ? (
                <div className="text-[10px] font-semibold text-blue-200 mb-1 leading-snug break-words [overflow-wrap:anywhere]">
                  {briefingTitle}
                </div>
              ) : null}
              {skipperNotice ? (
                <p data-testid="skipper-notice" className="text-[10px] font-semibold text-cyan-300 mb-1 leading-snug break-words [overflow-wrap:anywhere]">
                  {skipperNotice}
                </p>
              ) : null}
              <p
                data-testid="ici-briefing"
                className="text-[11px] text-slate-300 leading-snug whitespace-pre-line break-words [overflow-wrap:anywhere] max-w-full"
              >
                {briefingLoading
                  ? t("iciBriefingLoading")
                  : (iciBriefing && iciBriefingSegments?.length
                    ? <BriefingText segments={iciBriefingSegments} onFocus={onBriefingFocus} t={t} />
                    : (briefing || t("iciBriefingFallback")))}
              </p>
            </div>
          )}

          {isSuivre && !isDrawing && Array.isArray(story) && story.length ? (
            <div data-testid="expedition-story" className="rounded-lg border border-sky-500/25 bg-sky-950/30 p-2 min-w-0">
              <div className="text-[10px] font-semibold text-sky-200 leading-snug">{t("storyTitle")}</div>
              <div className="text-[9px] text-sky-100/60 leading-snug mb-1">{t("storyHint")}</div>
              {story.map((paragraph, i) => (
                <p key={i} className="text-[11px] text-slate-200 leading-snug break-words [overflow-wrap:anywhere] mt-1">
                  {paragraph}
                </p>
              ))}
            </div>
          ) : null}

          {isSuivre && !isDrawing ? (
            <JournalPanel journal={journal} loading={journalLoading} error={journalError} />
          ) : null}

          {!isDrawing && chat ? (
            <LogbookChat messages={chat.messages} pending={chat.pending} error={chat.error} onAsk={onChatAsk} />
          ) : null}

          {officialFallback && (
            <p className="text-[10px] text-amber-300/90 border border-amber-500/30 rounded-md px-2 py-1">
              {t("searouteUnavailable")}
            </p>
          )}
        </div>
      </div>
    </>
  );
});
