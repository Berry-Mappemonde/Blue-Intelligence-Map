"""Journal serveur du voyage officiel — la mémoire du produit (plan général §1.2).

`voyage_data/official_journal/YYYY-MM-DD.json` : une liste d'entrées par jour
UTC, écrite par le serveur seul :

- `position`  : le bateau de l'horloge officielle à 00, 06, 12, 18 UTC
                (basis `clock` : la position planifiée, pas un GPS) ;
- `stop`      : arrivée / départ d'une escale franchie ;
- `grib`      : vent, pression, pluie, Hs au bateau à chaque cycle GRIB ingéré ;
- `note`      : mot du skipper / de l'équipe (admin, X-Naviguide-Admin) ;
- `zee`       : ZEE entrée / quittée, lue sur les perles chauffées de la route
                (basis `pearl`), datée par l'horloge — v2, 19 sept. ;
- `amp`       : aire marine protégée venue à portée d'une perle (basis `pearl`) ;
- `poe`       : port d'entrée officiel passé à ≤ 15 nm d'une perle (basis `pearl`) ;
- `wx`        : météo marquante au bateau, dérivée d'une entrée `grib` déjà
                journalisée (vent ≥ WX_GALE_KT ou Hs ≥ WX_HS_M) — pas de GRIB,
                pas de `wx` (lot A).

Rien n'est inventé : une position vient de l'horloge, un vent d'un GRIB
réellement téléchargé. Les trous restent des trous (`absent`), le journal
ne rebouche pas. Relu par GET /voyage/official/journal ; il nourrit ensuite
replay, chapitres de l'expédition, fiche d'escale « vécue ».
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from saildocs import wind_at_daily
from voyage_clock import parse_iso, sample_clock_at_time, to_iso
from voyage_store import voyage_dir

SLOT_HOURS = (0, 6, 12, 18)
BACKFILL_MAX_DAYS = 400          # toute l'expédition, jamais plus
TICK_MIN_S = 60.0                # les GET publics ne réécrivent pas plus souvent
NOTE_MAX_CHARS = 2000
KINDS = ("position", "stop", "grib", "note", "zee", "amp", "poe", "wx", "chat")
CHAT_MAX_CHARS = 1200
WX_GALE_KT = 34.0   # Beaufort 8, the Cruise profile's gale
WX_HS_M = 3.5       # a sea worth a line in the log

_LOCK = threading.RLock()
_last_tick = 0.0
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ── fichiers ────────────────────────────────────────────────────────────────

def journal_dir() -> Path:
    d = voyage_dir() / "official_journal"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _day_of(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%d")


def _day_path(day: str) -> Path:
    if not _DAY_RE.match(day):
        raise ValueError("jour invalide")
    return journal_dir() / f"{day}.json"


def _read_day(day: str) -> List[dict]:
    path = _day_path(day)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _write_day(day: str, entries: List[dict]) -> None:
    path = _day_path(day)
    tmp = path.with_suffix(".tmp")
    entries = sorted(entries, key=lambda e: str(e.get("t") or ""))
    tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def _append(entries: Iterable[dict]) -> int:
    """Ajoute des entrées (dédoublonnées par id) dans le fichier de leur jour."""
    by_day: Dict[str, List[dict]] = {}
    for e in entries:
        by_day.setdefault(_day_of(parse_iso(e["t"])), []).append(e)
    added = 0
    with _LOCK:
        for day, news in by_day.items():
            current = _read_day(day)
            ids = {e.get("id") for e in current}
            fresh = [e for e in news if e.get("id") not in ids]
            if not fresh:
                continue
            _write_day(day, current + fresh)
            added += len(fresh)
    return added


def list_days() -> List[dict]:
    out = []
    for path in sorted(journal_dir().glob("????-??-??.json")):
        entries = _read_day(path.stem)
        kinds: Dict[str, int] = {}
        for e in entries:
            kinds[e.get("kind", "?")] = kinds.get(e.get("kind", "?"), 0) + 1
        out.append({"day": path.stem, "count": len(entries), "kinds": kinds})
    return out


def read_day(day: str) -> List[dict]:
    return _read_day(day)


def latest(limit: int = 50, kinds: Optional[Iterable[str]] = None) -> List[dict]:
    """Les `limit` dernières entrées, du plus récent au plus ancien."""
    wanted = set(kinds) if kinds else None
    out: List[dict] = []
    for path in sorted(journal_dir().glob("????-??-??.json"), reverse=True):
        day = _read_day(path.stem)
        day = [e for e in day if wanted is None or e.get("kind") in wanted]
        out.extend(reversed(day))
        if len(out) >= limit:
            break
    return out[:limit]


def _last_t(kind: str) -> Optional[datetime]:
    for path in sorted(journal_dir().glob("????-??-??.json"), reverse=True):
        ts = [e["t"] for e in _read_day(path.stem) if e.get("kind") == kind and e.get("t")]
        if ts:
            return parse_iso(max(ts))
    return None


def reset() -> None:
    global _last_tick
    with _LOCK:
        for path in journal_dir().glob("*.json"):
            path.unlink(missing_ok=True)
        _last_tick = 0.0


# ── positions ───────────────────────────────────────────────────────────────

def _slot_floor(t: datetime) -> datetime:
    t = t.astimezone(timezone.utc)
    h = max(s for s in SLOT_HOURS if s <= t.hour)
    return t.replace(hour=h, minute=0, second=0, microsecond=0)


def _slots_between(start: datetime, end: datetime) -> List[datetime]:
    """Créneaux 00/06/12/18 UTC dans ]start, end]."""
    out = []
    cur = _slot_floor(start) + timedelta(hours=6)
    while cur <= end:
        out.append(cur)
        cur += timedelta(hours=6)
    return out


def position_entry(clock: dict, slot: datetime) -> Optional[dict]:
    sample = sample_clock_at_time(clock, slot)
    if not sample or sample.get("lat") is None:
        return None
    return {
        "id": f"position:{to_iso(slot)}",
        "kind": "position",
        "t": to_iso(slot),
        "lat": round(float(sample["lat"]), 4),
        "lon": round(float(sample["lon"]), 4),
        "sailNm": round(float(sample.get("sailNm") or 0), 1),
        "filmNm": round(float(sample.get("filmNm") or 0), 1),
        "vehicle": sample.get("vehicle"),
        "status": sample.get("status"),
        "atQuay": bool(sample.get("atQuay")),
        "speedKnots": sample.get("speedKnots"),
        "basis": "clock",
    }


def record_positions(clock: dict, now: datetime, *, max_days: int = BACKFILL_MAX_DAYS) -> int:
    t0 = parse_iso(clock["t0"])
    start = _last_t("position") or (t0 - timedelta(hours=6))
    floor = now - timedelta(days=max_days)
    if start < floor:
        start = floor
    if start < t0 - timedelta(hours=6):
        start = t0 - timedelta(hours=6)
    entries = [e for e in (position_entry(clock, s) for s in _slots_between(start, now)) if e]
    return _append(entries)


# ── escales ─────────────────────────────────────────────────────────────────

def record_stops(clock: dict, now: datetime) -> int:
    t0 = parse_iso(clock["t0"])
    entries = []
    for m in clock.get("marks") or []:
        name = str(m.get("name") or "").strip()
        if not name or m.get("tHours") is None:
            continue
        arrival = t0 + timedelta(hours=float(m["tHours"]))
        key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if arrival <= now:
            entries.append({
                "id": f"stop:{key}:arrival",
                "kind": "stop",
                "t": to_iso(arrival),
                "event": "arrival",
                "name": name,
                "filmNm": m.get("filmNm"),
                "holdHours": m.get("holdHours"),
                "basis": "clock",
            })
        hold = float(m.get("holdHours") or 0)
        departure = arrival + timedelta(hours=hold)
        if hold > 0 and departure <= now:
            entries.append({
                "id": f"stop:{key}:departure",
                "kind": "stop",
                "t": to_iso(departure),
                "event": "departure",
                "name": name,
                "filmNm": m.get("filmNm"),
                "basis": "clock",
            })
    return _append(entries)


# ── événements de route (perles) ────────────────────────────────────────────

def _time_at_sail_nm(clock: dict, sail_nm: float) -> Optional[datetime]:
    """When the official clock puts the boat at `sail_nm` sea miles (first crossing)."""
    verts = clock.get("vertices") or []
    t0 = parse_iso(clock["t0"])
    x = float(sail_nm)
    for a, b in zip(verts, verts[1:]):
        sa, sb = float(a.get("sailNm") or 0), float(b.get("sailNm") or 0)
        if sb < x - 1e-6 or sb <= sa:
            continue
        if x < sa - 1e-6:
            return t0 + timedelta(hours=float(a["tHours"]))
        t = (x - sa) / (sb - sa) if sb > sa else 0.0
        hours = float(a["tHours"]) + t * (float(b["tHours"]) - float(a["tHours"]))
        return t0 + timedelta(hours=hours)
    return None


def record_route_events(voy: Optional[dict], clock: Optional[dict], now: datetime) -> int:
    """ZEE crossings and MPA neighbourhoods read on the warmed pearls, dated
    by the clock, once each (idempotent ids). Pearls not warmed yet: nothing
    is written — the next tick will, when the cache knows them."""
    if not voy or not clock or not voy.get("points"):
        return 0
    from ici_warm import route_events_from_pearls  # noqa: PLC0415
    entries = []
    for ev in route_events_from_pearls(voy["points"]):
        when = _time_at_sail_nm(clock, ev["sailNm"])
        if when is None or when > now:
            continue
        ident = ev.get("poeId") if ev["kind"] == "poe" else (ev.get("mrgid") or ev.get("siteId") or ev.get("name") or "")
        key = re.sub(r"[^a-z0-9]+", "-", str(ident).lower()).strip("-")
        entries.append({
            "id": f"{ev['kind']}:{ev['event']}:{key}:{ev['idx']}",
            "t": to_iso(when),
            **{k: v for k, v in ev.items() if k != "idx"},
        })
    # Pearl-derived lines are a *reading* of the pearls, not a record: as the
    # warmer refines them (thin → rich, a better ZEE), the reading changes.
    # Keep the journal equal to the current reading — never a pile of readings.
    _drop_basis_not_in("pearl", {e["id"] for e in entries})
    return _append(entries)


def _drop_basis_not_in(basis: str, keep_ids: set) -> int:
    """Remove entries of `basis` whose id is not in `keep_ids`."""
    removed = 0
    with _LOCK:
        for path in sorted(journal_dir().glob("*.json")):
            entries = _read_day(path.stem)
            kept = [e for e in entries if e.get("basis") != basis or e.get("id") in keep_ids]
            if len(kept) != len(entries):
                removed += len(entries) - len(kept)
                if kept:
                    _write_day(path.stem, kept)
                else:
                    try:
                        path.unlink()
                    except OSError:
                        pass
    return removed


def wx_entry_from_grib(grib: dict) -> Optional[dict]:
    """A `wx` line derived from a journaled GRIB reading — or None when the
    weather was unremarkable. Same numbers, same time, nothing added."""
    wind = grib.get("windKnots")
    hs = grib.get("hs")
    gale = isinstance(wind, (int, float)) and wind >= WX_GALE_KT
    sea = isinstance(hs, (int, float)) and hs >= WX_HS_M
    if not gale and not sea:
        return None
    return {
        "id": f"wx:{grib.get('id') or grib.get('cycle') or grib.get('t')}",
        "kind": "wx",
        "t": grib["t"],
        "event": "gale" if gale else "sea",
        "windKnots": wind,
        "dirFromDeg": grib.get("dirFromDeg"),
        "hs": hs,
        "lat": grib.get("lat"),
        "lon": grib.get("lon"),
        "model": grib.get("model"),
        "from": grib.get("id"),
        "basis": "forecast",
    }


def record_wx(now: datetime) -> int:
    """Derive `wx` entries from every journaled GRIB reading (idempotent)."""
    del now
    entries = [e for e in (wx_entry_from_grib(g) for g in latest(5000, kinds=("grib",))) if e]
    return _append(entries)


# ── GRIB ────────────────────────────────────────────────────────────────────

def record_grib(record: Optional[dict], clock: Optional[dict], now: datetime) -> bool:
    """Le GRIB du cycle au bateau (position horloge à `now`). Une entrée par cycle."""
    if not record or record.get("status") != "ready" or not clock:
        return False
    sample = sample_clock_at_time(clock, now)
    if not sample or sample.get("lat") is None:
        return False
    lat, lon = float(sample["lat"]), float(sample["lon"])
    wind = wind_at_daily(record, lat, lon, now)
    if not wind:
        return False
    cycle = str(record.get("cycle") or record.get("issued") or to_iso(now))
    entry = {
        "id": f"grib:{cycle}",
        "kind": "grib",
        "t": to_iso(now),
        "cycle": cycle,
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "windKnots": wind.get("windKnots"),
        "dirFromDeg": wind.get("dirFromDeg"),
        "pressHpa": wind.get("pressHpa"),
        "rainMm": wind.get("rainMm"),
        "hs": wind.get("hs"),
        "model": wind.get("model"),
        "waveModel": wind.get("waveModel"),
        "source": record.get("source"),
        "basis": "forecast",
    }
    added = _append([entry]) > 0
    if added:
        wx = wx_entry_from_grib(entry)
        if wx:
            _append([wx])
    return added


# ── notes ───────────────────────────────────────────────────────────────────

def add_note(text: str, now: datetime, *, author: str = "skipper", lang: str = "fr") -> dict:
    clean = " ".join(str(text or "").split())
    if not clean:
        raise ValueError("note vide")
    if len(clean) > NOTE_MAX_CHARS:
        raise ValueError(f"note trop longue (> {NOTE_MAX_CHARS} caractères)")
    entry = {
        "id": f"note:{uuid.uuid4().hex[:12]}",
        "kind": "note",
        "t": to_iso(now),
        "text": clean,
        "author": (author or "skipper")[:40],
        "lang": (lang or "fr")[:5],
        "basis": "human",
    }
    _append([entry])
    return entry


def add_chat(question: str, answer: str, summary: str, now: datetime, *, lang: str = "fr", engine: str | None = None) -> dict:
    """Un échange avec le journal de bord (lot D) : horodatage, question,
    réponse, résumé. Écrit tel quel — le LLM a répondu, le journal se souvient."""
    q = " ".join(str(question or "").split())[:CHAT_MAX_CHARS]
    a = " ".join(str(answer or "").split())[:CHAT_MAX_CHARS]
    if not q or not a:
        raise ValueError("échange vide")
    entry = {
        "id": f"chat:{uuid.uuid4().hex[:12]}",
        "kind": "chat",
        "t": to_iso(now),
        "question": q,
        "answer": a,
        "summary": " ".join(str(summary or "").split())[:300] or q[:120],
        "lang": (lang or "fr")[:5],
        "engine": (engine or None),
        "basis": "human+llm",
    }
    _append([entry])
    return entry


# ── tick ────────────────────────────────────────────────────────────────────

def tick(voy: Optional[dict], now: datetime, *, force: bool = False) -> Dict[str, Any]:
    """Positions et escales manquantes depuis la dernière fois. Peu coûteux,
    borné à une écriture par minute (les GET publics l'appellent)."""
    global _last_tick
    if not voy or not voy.get("clock"):
        return {"positions": 0, "stops": 0, "skipped": True}
    mono = time.monotonic()
    with _LOCK:
        if not force and mono - _last_tick < TICK_MIN_S:
            return {"positions": 0, "stops": 0, "skipped": True}
        _last_tick = mono
    clock = voy["clock"]
    out = {
        "positions": record_positions(clock, now),
        "stops": record_stops(clock, now),
        "skipped": False,
    }
    try:
        out["routeEvents"] = record_route_events(voy, clock, now)
    except Exception:  # the pearls never break the journal
        out["routeEvents"] = 0
    try:
        out["wx"] = record_wx(now)
    except Exception:
        out["wx"] = 0
    return out


EVENT_KINDS = ("stop", "grib", "note", "zee", "amp", "poe", "wx", "chat")
EVENTS_MAX = 800


def summary(limit: int = 50) -> Dict[str, Any]:
    days = list_days()
    return {
        "days": days,
        "count": sum(d["count"] for d in days),
        "first": days[0]["day"] if days else None,
        "last": days[-1]["day"] if days else None,
        "latest": latest(limit),
        # Everything but the 4-a-day positions, whole voyage: what the story
        # of the crossing reads (ZEE crossed, MPA met, stops, wind, notes).
        "events": latest(EVENTS_MAX, kinds=EVENT_KINDS),
        "kinds": list(KINDS),
    }
