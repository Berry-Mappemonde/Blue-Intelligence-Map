/**
 * Journal de bord du voyage officiel — mise en mots des entrées serveur
 * (GET /voyage/official/journal). Pur, testé, deux langues. Aucun chiffre
 * n'est inventé : ce qui manque reste absent.
 */
import { getCardinalDirection } from "../utils/getCardinalDirection.js";

const EN_CARDINAL = { O: "W", NO: "NW", SO: "SW", ONO: "WNW", OSO: "WSW", NNO: "NNW", SSO: "SSW" };

function cardinal(deg, lang) {
  if (!Number.isFinite(deg)) return "";
  const fr = getCardinalDirection(deg);
  if (lang === "en") return EN_CARDINAL[fr] || fr;
  return fr;
}

function num(v, lang, digits = 0, { grouping = true } = {}) {
  if (!Number.isFinite(v)) return "—";
  return Number(v).toLocaleString(lang === "en" ? "en-GB" : "fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: grouping,
  });
}

/** 46.15, -1.16 → "46,15° N · 1,16° O" (FR) / "46.15° N · 1.16° W" (EN). */
export function formatLatLon(lat, lon, lang = "fr") {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : (lang === "en" ? "W" : "O");
  return `${num(Math.abs(lat), lang, 2)}° ${ns} · ${num(Math.abs(lon), lang, 2)}° ${ew}`;
}

/** "2026-05-16T06:00:00Z" → "06:00 UTC". */
export function formatTimeUtc(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ""));
  return m ? `${m[1]}:${m[2]} UTC` : "";
}

/** "2026-05-16" → "16 mai 2026" / "16 May 2026". */
export function formatDay(day, lang = "fr") {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ""));
  if (!m) return String(day || "");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(lang === "en" ? "en-GB" : "fr-FR", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export const KIND_ICON = Object.freeze({ position: "📍", stop: "⚓", grib: "🌬", note: "📝", zee: "🛂", amp: "🐟", poe: "🛃", wx: "⚠️", chat: "💬" });

/** One journal entry → { icon, time, text }. Unknown kinds keep their raw kind. */
export function formatJournalEntry(entry, lang = "fr") {
  const en = lang === "en";
  const e = entry || {};
  const time = formatTimeUtc(e.t);
  const icon = KIND_ICON[e.kind] || "•";
  let text = "";
  switch (e.kind) {
    case "position": {
      const where = formatLatLon(e.lat, e.lon, lang);
      const nm = Number.isFinite(e.sailNm) ? `${num(e.sailNm, lang)} nm` : "";
      let state = "";
      if (e.status === "waiting") state = en ? "before departure" : "avant le départ";
      else if (e.status === "arrived") state = en ? "arrived" : "arrivé";
      else if (e.atQuay || e.vehicle === "quay") state = en ? "alongside" : "à quai";
      else if (e.vehicle === "plane") state = en ? "by air" : "en avion";
      else state = en ? "at sea" : "en mer";
      text = [where, nm, state].filter(Boolean).join(" · ");
      break;
    }
    case "stop": {
      const name = e.name || "";
      text = e.event === "departure"
        ? (en ? `Departure from ${name}` : `Départ de ${name}`)
        : (en ? `Arrival at ${name}` : `Arrivée à ${name}`);
      if (e.event !== "departure" && Number.isFinite(e.holdHours) && e.holdHours > 0) {
        const days = Math.round(e.holdHours / 24);
        text += en ? ` · ${days} day${days > 1 ? "s" : ""} alongside` : ` · ${days} jour${days > 1 ? "s" : ""} à quai`;
      }
      break;
    }
    case "grib": {
      const parts = [];
      if (Number.isFinite(e.windKnots)) {
        const dir = cardinal(e.dirFromDeg, lang);
        parts.push(en
          ? `Wind ${num(e.windKnots, lang)} kn${dir ? ` from ${dir}` : ""}`
          : `Vent ${num(e.windKnots, lang)} kn${dir ? ` de ${dir}` : ""}`);
      }
      if (Number.isFinite(e.pressHpa)) parts.push(`${num(e.pressHpa, lang, 0, { grouping: false })} hPa`);
      if (Number.isFinite(e.hs)) parts.push(`Hs ${num(e.hs, lang, 1)} m`);
      if (Number.isFinite(e.rainMm) && e.rainMm > 0) parts.push(en ? `rain ${num(e.rainMm, lang, 1)} mm` : `pluie ${num(e.rainMm, lang, 1)} mm`);
      text = parts.join(" · ") || (en ? "GRIB received" : "GRIB reçu");
      if (e.model) text += ` (${e.model})`;
      break;
    }
    case "note":
      text = e.author ? `${e.author} : ${e.text || ""}` : (e.text || "");
      break;
    case "zee": {
      const name = e.name || (en ? "EEZ" : "ZEE");
      text = e.event === "exit"
        ? (en ? `Left ${name} — high seas` : `${name} quittée — haute mer`)
        : (en ? `Entered ${name}` : `Entrée dans ${name}`);
      break;
    }
    case "amp": {
      const name = e.name || (en ? "marine protected area" : "aire marine protégée");
      const nm = Number.isFinite(e.nm) ? ` (${num(e.nm, lang, 1)} nm)` : "";
      text = en ? `Marine protected area within reach: ${name}${nm}` : `Aire marine protégée à portée : ${name}${nm}`;
      break;
    }
    case "poe": {
      const name = e.name || (en ? "port of entry" : "port d’entrée");
      const nm = Number.isFinite(e.nm) ? ` (${num(e.nm, lang, 1)} nm)` : "";
      text = en ? `Port of entry passed: ${name}${nm}` : `Port d’entrée passé : ${name}${nm}`;
      break;
    }
    case "chat":
      text = e.summary || (e.question ? `${e.question} → ${e.answer || ""}` : (e.answer || ""));
      break;
    case "wx": {
      const parts = [];
      if (Number.isFinite(e.windKnots)) {
        const dir = cardinal(e.dirFromDeg, lang);
        parts.push(en ? `wind ${num(e.windKnots, lang)} kn${dir ? ` from ${dir}` : ""}` : `vent ${num(e.windKnots, lang)} kn${dir ? ` de ${dir}` : ""}`);
      }
      if (Number.isFinite(e.hs)) parts.push(`Hs ${num(e.hs, lang, 1)} m`);
      const head = e.event === "sea" ? (en ? "Heavy sea" : "Mer forte") : (en ? "Gale" : "Coup de vent");
      text = `${head}${parts.length ? ` : ${parts.join(" · ")}` : ""}${e.model ? ` (${e.model})` : ""}`;
      break;
    }
    default:
      text = e.text || e.kind || "";
  }
  return { icon, time, text, kind: e.kind || "?" };
}

/** Entries (newest first, as served) → [{ day, label, entries: [formatted…] }], newest day first. */
export function groupJournalByDay(entries, lang = "fr", { maxDays = 7 } = {}) {
  const groups = new Map();
  for (const e of entries || []) {
    const day = String(e.t || "").slice(0, 10);
    if (!day) continue;
    if (!groups.has(day)) {
      if (groups.size >= maxDays) continue;
      groups.set(day, []);
    }
    groups.get(day).push({ id: e.id, ...formatJournalEntry(e, lang) });
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => ({ day, label: formatDay(day, lang), entries: list }));
}
