"""Chatbot journal de bord (lot D, commentaires 3 et 4 du porteur).

Le skipper pose une question sur **toutes les données de l'application** —
position et vent au bateau (horloge + GRIB), ZEE, ports d'entrée, AMP, ports,
projets et fiches science autour, prochaine escale, polaire et ordres du
skipper (envoyés par le client), journal — et la réponse **cite un JSON de
faits construit ici**, jamais le monde. Cascade LLM habituelle
(NIM → OpenRouter → Claude), pas de Nebius, pas de Tavily.

Pas de détection d'intention : **chaque échange est consigné** dans le
journal (`kind: chat` : horodatage, question, réponse, résumé) quand la clé
admin est là ; sans clé, la réponse est rendue sans consignation.

Un chiffre ne passe jamais par le LLM : toute phrase de la réponse qui porte
un nombre absent du contexte est retirée.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from admin_guard import is_admin, rate_limited
from story_cascade import cascade_text, tidy_story

log = logging.getLogger("naviguide-simulator.logbook")

router = APIRouter()

QUESTION_MAX = 500
CONTEXT_MAX_BYTES = 12_000
ANSWER_SENTENCES = 3
ANSWER_CHARS = 480
JOURNAL_TAIL = 20

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+(?=[^\s])")


# ── context ─────────────────────────────────────────────────────────────────

def _slim_places(items: Any, n: int = 4) -> list[dict]:
    out = []
    for it in items or []:
        if isinstance(it, dict) and it.get("name"):
            row = {"name": it["name"]}
            if isinstance(it.get("nm"), (int, float)):
                row["nm"] = round(float(it["nm"]), 1)
            out.append(row)
        if len(out) >= n:
            break
    return out


def _next_stop(clock: dict | None, now: datetime) -> Optional[dict]:
    if not clock:
        return None
    from voyage_clock import parse_iso  # noqa: PLC0415
    t0 = parse_iso(clock["t0"])
    for m in clock.get("marks") or []:
        if m.get("tHours") is None or not m.get("name"):
            continue
        from datetime import timedelta  # noqa: PLC0415
        eta = t0 + timedelta(hours=float(m["tHours"]))
        if eta > now:
            return {"name": m["name"], "eta": eta.isoformat().replace("+00:00", "Z"), "holdDays": round(float(m.get("holdHours") or 0) / 24)}
    return None


async def build_context(client_ctx: dict | None, now: datetime, http: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """The facts the bot may cite. Nothing here comes from the model."""
    from voyage_api import _grib_around_from_live, _latest_official_grib, _now  # noqa: PLC0415
    from voyage_clock import OFFICIAL_VOYAGE_ID, sample_clock_at_time  # noqa: PLC0415
    from voyage_store import load_voyage  # noqa: PLC0415
    from saildocs import wind_at_daily  # noqa: PLC0415
    import voyage_journal as journal  # noqa: PLC0415

    ctx: dict[str, Any] = {"now": now.isoformat().replace("+00:00", "Z")}
    client_ctx = client_ctx if isinstance(client_ctx, dict) else {}
    view = str(client_ctx.get("view") or "suivre")[:12]
    ctx["view"] = view

    voy = load_voyage(OFFICIAL_VOYAGE_ID)
    clock = (voy or {}).get("clock")
    live = None
    if clock:
        sample = sample_clock_at_time(clock, now)
        if sample and sample.get("lat") is not None:
            live = {
                "lat": round(float(sample["lat"]), 3),
                "lon": round(float(sample["lon"]), 3),
                "sailNm": round(float(sample.get("sailNm") or 0)),
                "speedKnots": sample.get("speedKnots"),
                "atQuay": bool(sample.get("atQuay")),
                "status": sample.get("status"),
                "basis": "clock",
            }
            try:
                around = _grib_around_from_live(voy, now)
                grib = _latest_official_grib(around, now)
                wind = wind_at_daily(grib, float(sample["lat"]), float(sample["lon"]), now)
                if wind:
                    live["wind"] = {k: wind.get(k) for k in ("windKnots", "dirFromDeg", "pressHpa", "rainMm", "hs", "model") if wind.get(k) is not None}
                    live["wind"]["kind"] = "forecast"
                else:
                    live["wind"] = {"kind": "absent"}
            except Exception as exc:
                live["wind"] = {"kind": "absent", "reason": type(exc).__name__}
    ctx["official"] = live
    ctx["nextStop"] = _next_stop(clock, now)

    # The boat the question is about: the official one, or the film boat the client sent.
    boat = client_ctx.get("boat") if isinstance(client_ctx.get("boat"), dict) else None
    lat = lon = None
    if boat and isinstance(boat.get("lat"), (int, float)) and isinstance(boat.get("lon"), (int, float)):
        lat, lon = float(boat["lat"]), float(boat["lon"])
        ctx["boat"] = {"lat": round(lat, 3), "lon": round(lon, 3), "basis": "simulation", "iso": boat.get("iso")}
    elif live:
        lat, lon = live["lat"], live["lon"]
        ctx["boat"] = {"lat": lat, "lon": lon, "basis": "clock"}

    if lat is not None:
        try:
            from ici_engine import fill_dossier  # noqa: PLC0415
            bag = await fill_dossier(lat, lon, 30.0, client=http, thin=True, rich=True)
            nearby = bag.get("nearby") or {}
            science = bag.get("science")
            ctx["around"] = {
                "zee": {k: (bag.get("zee") or {}).get(k) for k in ("name", "mrgid", "gold") if (bag.get("zee") or {}).get(k) is not None} or None,
                "portsOfEntry": _slim_places(bag.get("poe")),
                "protectedAreas": _slim_places(bag.get("amp")),
                "marinas": _slim_places(nearby.get("marinas")),
                "harbourMasters": _slim_places(nearby.get("capitaineries"), 2),
                "ports": _slim_places(nearby.get("wpi"), 3),
                "projects": _slim_places(bag.get("projects"), 3),
                "science": _slim_places(science.get("nearby") if isinstance(science, dict) else science, 3),
                "aidsToNavigation": _slim_places((bag.get("aton") or {}).get("nearby"), 3),
                "depthM": ((bag.get("emodnet") or {}).get("bathy") or {}).get("depth_m"),
            }
        except Exception as exc:
            ctx["around"] = {"reason": f"unavailable:{type(exc).__name__}"}

    tail = journal.latest(JOURNAL_TAIL, kinds=("stop", "grib", "note", "zee", "amp", "poe", "wx", "chat"))
    ctx["journal"] = [
        {k: e.get(k) for k in ("kind", "t", "event", "name", "text", "windKnots", "dirFromDeg", "hs", "summary") if e.get(k) is not None}
        for e in tail
    ]

    # What only the client knows: its polar, its skipper's orders, its view.
    for key in ("polar", "orders", "leg"):
        val = client_ctx.get(key)
        if isinstance(val, dict):
            ctx[key] = val
    return ctx


# ── answer ──────────────────────────────────────────────────────────────────

def _prompt(question: str, ctx: dict, lang: str) -> tuple[str, str]:
    en = (lang or "fr").lower().startswith("en")
    system = (
        "You are the logbook of the Berry-Mappemonde sailing expedition. Answer the skipper's question in at most "
        "THREE plain sentences, using ONLY the JSON of facts provided (positions, wind, zones, ports, areas, journal, "
        "polar, skipper's orders). Every figure you write must appear in the JSON, with its unit. If the JSON does not "
        "hold the answer, say so in one sentence. No title, no list, no bold, nothing about tools or models. Thinking OFF."
        if en else
        "Tu es le journal de bord de l’expédition à la voile Berry-Mappemonde. Réponds à la question du skipper en "
        "TROIS phrases simples au plus, à partir du SEUL JSON de faits fourni (positions, vent, zones, ports, aires, "
        "journal, polaire, ordres du skipper). Chaque chiffre que tu écris doit figurer dans le JSON, avec son unité. "
        "Si le JSON ne contient pas la réponse, dis-le en une phrase. Ni titre, ni liste, ni gras, rien sur les outils "
        "ou les modèles. Thinking OFF."
    )
    user = f"{'Question' if en else 'Question'} : {question}\nJSON :\n{json.dumps(ctx, ensure_ascii=False, default=str)}"
    return system, user


def _numbers(text: str) -> set[str]:
    out = set()
    for m in _NUM_RE.findall(text or ""):
        try:
            out.add(format(float(m.replace(",", ".")), "g"))  # "03" == "3", "14,2" == "14.2"
        except ValueError:
            continue
    return out


def filter_numbers(answer: str, ctx: dict) -> tuple[str, int]:
    """Drop every sentence carrying a number absent from the context (a year
    or a time in the context counts). Returns (text, dropped)."""
    allowed = _numbers(json.dumps(ctx, ensure_ascii=False, default=str))
    # Dates split into parts: 2026-05-15T08:00 → 2026, 05, 15, 08, 00 are all present already via _NUM_RE.
    kept, dropped = [], 0
    for s in _SENT_SPLIT_RE.split(answer or ""):
        s = s.strip()
        if not s:
            continue
        nums = _numbers(s)
        if nums and not nums.issubset(allowed):
            dropped += 1
            continue
        kept.append(s)
    return " ".join(kept), dropped


def summarize(question: str, answer: str) -> str:
    q = " ".join((question or "").split())[:90]
    first = _SENT_SPLIT_RE.split(answer or "")[0].strip() if answer else ""
    return f"{q} → {first[:160]}".strip(" →")


async def answer_question(question: str, lang: str, client_ctx: dict | None, now: datetime,
                          http: httpx.AsyncClient | None = None) -> dict[str, Any]:
    ctx = await build_context(client_ctx, now, http)
    system, user = _prompt(question, ctx, lang)
    try:
        raw, engine = await cascade_text(system, user, http)
    except Exception as exc:
        return {"status": "failed", "reason": str(exc)[:160], "answer": None, "engine": None, "context": ctx}
    tidy = tidy_story(raw, None, max_sentences=ANSWER_SENTENCES, max_chars=ANSWER_CHARS)
    text, dropped = filter_numbers(tidy, ctx)
    if not text:
        text = ("Le journal n’a pas cette information dans ses données." if not (lang or "fr").startswith("en")
                else "The logbook does not hold that information in its data.")
    return {"status": "ready", "answer": text, "engine": engine, "droppedSentences": dropped, "context": ctx}


# ── endpoint ────────────────────────────────────────────────────────────────

class ChatIn(BaseModel):
    question: str
    lang: Optional[str] = "fr"
    context: Optional[dict] = None


_chat_limited = rate_limited("logbook-chat", 6, 60.0, global_limit=60)


@router.post("/logbook/chat", dependencies=[Depends(_chat_limited)])
async def post_logbook_chat(body: ChatIn, request: Request):
    """Une question au journal de bord ; consignée (kind chat) quand la clé admin est là."""
    q = " ".join((body.question or "").split())
    if not q:
        raise HTTPException(400, "question vide")
    if len(q) > QUESTION_MAX:
        raise HTTPException(413, f"question trop longue (> {QUESTION_MAX} caractères)")
    if body.context is not None and len(json.dumps(body.context, default=str)) > CONTEXT_MAX_BYTES:
        raise HTTPException(413, "contexte trop volumineux")
    now = datetime.now(timezone.utc)
    out = await answer_question(q, body.lang or "fr", body.context, now)
    logged = False
    entry = None
    if out["status"] == "ready" and is_admin(request):
        import voyage_journal as journal  # noqa: PLC0415
        try:
            entry = journal.add_chat(q, out["answer"], summarize(q, out["answer"]), now, lang=body.lang or "fr", engine=out.get("engine"))
            logged = True
        except Exception as exc:  # the journal never breaks an answer
            log.warning("journal chat : %s", exc)
    return {
        "status": out["status"],
        "answer": out.get("answer"),
        "reason": out.get("reason"),
        "engine": out.get("engine"),
        "logged": logged,
        "entry": entry,
        "t": now.isoformat().replace("+00:00", "Z"),
        "facts": {k: out["context"].get(k) for k in ("official", "boat", "nextStop") if out["context"].get(k) is not None},
    }
