"""Chatbot journal de bord (lot D) : faits serveur, cascade, filtre des chiffres, consignation."""
import asyncio
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

import admin_guard
import forecast_cube
import ici_engine
import logbook_chat
import saildocs
import story_cascade
import voyage_api
import voyage_journal as journal
import voyage_store
from tests.test_ici_engine import _handler
from tests.test_voyage_journal import PUBLIC, T0, _official
from voyage_clock import OFFICIAL_VOYAGE_ID

ADMIN = {"X-Naviguide-Admin": "s3cret", "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NAVIGUIDE_FORECAST_BACKEND", "synthetic")
    monkeypatch.setenv("NAVIGUIDE_FORECAST_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("NAVIGUIDE_GRIB_DIR", str(tmp_path / "grib"))
    monkeypatch.setenv("NAVIGUIDE_GRIB_AUTO", "0")
    monkeypatch.setenv(admin_guard.ADMIN_ENV, "s3cret")
    forecast_cube.CACHE_DIR = tmp_path / "cache"
    saildocs.GRIB_DIR = tmp_path / "grib"
    journal.reset()
    admin_guard.reset_limiters()
    ici_engine.reset_caches()
    from main import app
    return TestClient(app)


def _llm_transport(answer: str):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "integrate.api.nvidia.com" in url or "openrouter.ai" in url or "api.anthropic.com" in url:
            return httpx.Response(200, json={"choices": [{"message": {"content": answer}}]})
        return _handler(request)
    return httpx.MockTransport(handler)


def test_filter_numbers_drops_sentences_with_figures_absent_from_the_facts():
    ctx = {"official": {"wind": {"windKnots": 14.2, "dirFromDeg": 250}}, "nextStop": {"name": "Ajaccio", "eta": "2026-10-03T10:00:00Z"}}
    text, dropped = logbook_chat.filter_numbers(
        "Le vent est de 14,2 kn de 250°. Il fera 30 kn demain. Arrivée à Ajaccio le 3 octobre.", ctx,
    )
    assert "14,2" in text and "Ajaccio" in text
    assert "30 kn" not in text and dropped == 1


def test_summary_is_question_then_first_sentence():
    assert logbook_chat.summarize("Quel vent ?", "Vent 14 kn de OSO. Pression 1013 hPa.") == "Quel vent ? → Vent 14 kn de OSO."


def test_chat_answers_from_server_facts_and_logs_only_for_admin(client, monkeypatch):
    now = T0 + timedelta(days=3)
    monkeypatch.setattr(voyage_api, "_now", lambda: now)
    client.put("/voyage/official", json=_official(), headers=ADMIN)
    monkeypatch.setattr(story_cascade, "nvidia_key", lambda: "test")
    transport = _llm_transport("Le bateau est en mer, dans French Exclusive Economic Zone. Le vent au bateau est de 99 kn. Prochaine escale Fort-de-France (Martinique).")
    real = logbook_chat.answer_question

    async def patched(question, lang, client_ctx, when, http=None):
        async with httpx.AsyncClient(transport=transport) as c:
            return await real(question, lang, client_ctx, when, c)

    monkeypatch.setattr(logbook_chat, "answer_question", patched)

    # Public: an answer, not logged.
    r = client.post("/logbook/chat", json={"question": "Où est le bateau ?", "lang": "fr", "context": {"view": "suivre"}}, headers=PUBLIC)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ready" and body["logged"] is False
    assert "99 kn" not in body["answer"], "a figure absent from the facts is dropped"
    assert "Fort-de-France" in body["answer"]
    assert body["facts"]["official"]["basis"] == "clock"
    assert journal.latest(10, kinds=("chat",)) == []

    # Admin: the exchange is logged with its summary.
    r2 = client.post("/logbook/chat", json={"question": "Où est le bateau ?", "lang": "fr"}, headers=ADMIN)
    assert r2.json()["logged"] is True
    chats = journal.latest(10, kinds=("chat",))
    assert len(chats) == 1
    assert chats[0]["question"] == "Où est le bateau ?" and chats[0]["summary"].startswith("Où est le bateau ? →")
    assert chats[0]["basis"] == "human+llm"
    # The journal summary lists chats among the events; kinds advertise it.
    body = client.get("/voyage/official/journal?limit=5", headers=PUBLIC).json()
    assert "chat" in body["kinds"] and any(e["kind"] == "chat" for e in body["events"])
    # Guards.
    assert client.post("/logbook/chat", json={"question": "   "}, headers=PUBLIC).status_code == 400
    assert client.post("/logbook/chat", json={"question": "x" * 600}, headers=PUBLIC).status_code == 413


def test_chat_without_llm_backend_fails_honestly(client, monkeypatch):
    now = T0 + timedelta(days=3)
    monkeypatch.setattr(voyage_api, "_now", lambda: now)
    client.put("/voyage/official", json=_official(), headers=ADMIN)
    monkeypatch.setattr(story_cascade, "nvidia_key", lambda: "")
    monkeypatch.setattr(story_cascade, "openrouter_key", lambda: "")
    monkeypatch.setattr(story_cascade, "anthropic_key", lambda: "")
    r = client.post("/logbook/chat", json={"question": "Quel vent ?"}, headers=ADMIN)
    body = r.json()
    assert body["status"] == "failed" and body["answer"] is None and body["logged"] is False
    assert journal.latest(10, kinds=("chat",)) == []
