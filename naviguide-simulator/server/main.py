"""NAVIGUIDE simulator API — searoute, polar (sans chat), proxies, vent."""
from __future__ import annotations

import asyncio
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import List, Optional, Union

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

_DIR = Path(__file__).resolve().parent
_SIM_ROOT = _DIR.parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

import httpx

from admin_guard import cors_origins, rate_limited
from mem_limits import (
    ZEE_CACHE_MAX_BYTES,
    ZEE_MAX_FEATURES_CAP,
    ZEE_NO_BBOX_MAX_FEATURES,
    ZEE_RESPONSE_MAX_BYTES,
    lru_set,
    too_large,
)
from weather_pipeline import get_pipeline
from ici_engine import ICI_RADIUS_NM, fetch_wpi_features, fill_dossier
from story_cascade import write_story
from polar_api import router as polar_router
from escale_api import router as escale_router
from logbook_chat import router as logbook_router
from route_engine import searoute_with_exact_end
from spatial_catalog import MAX_RENDER_FEATURES, SpatialCatalogIndex, parse_bbox
from voyage_api import router as voyage_router

load_dotenv(_SIM_ROOT / ".env")

COPERNICUS_USERNAME = os.getenv("COPERNICUS_USERNAME")
COPERNICUS_PASSWORD = os.getenv("COPERNICUS_PASSWORD")

try:
    from copernicus.getWind import get_wind_data_at_position
    from copernicus.getWave import get_wave_data_at_position
    from copernicus.getCurrent import get_current_data_at_position
except Exception as exc:
    get_wind_data_at_position = None
    get_wave_data_at_position = None
    get_current_data_at_position = None
    print(f"⚠️  Copernicus Marine non chargé ({type(exc).__name__}: {exc})")

app = FastAPI(
    title="NAVIGUIDE simulator",
    description="Cockpit Berry-Mappemonde — hors production.",  # pragma: allowlist secret
    version="0.1.0",
)
# Sécurité P0 : plus de "*" — le client de prod est servi par le même nginx,
# CORS ne concerne que le dev Vite (5174) et les outils. NAVIGUIDE_CORS_ORIGINS
# pour changer la liste sans toucher au code.
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "X-Naviguide-Admin"],
)
app.include_router(polar_router)
app.include_router(voyage_router)
app.include_router(escale_router)
app.include_router(logbook_router)


@app.on_event("startup")
def _startup_official_grib():
    """Dernier GRIB dès le boot serveur — pas attendre le premier GET front."""
    try:
        from voyage_api import _kick_official_grib
        _kick_official_grib()
    except Exception:
        pass


@app.on_event("startup")
async def _startup_ici_warm():
    """Perles along de la route officielle : cache disque rechargé, puis
    chauffé en fond (une perle toutes les ~1,2 s). NAVIGUIDE_ICI_WARM=0 coupe.
    Avant, la couche ZEE VLIZ locale (lot B) : chargée si en cache, sinon
    téléchargée en fond — le chauffeur lit les ZEE en local dès qu'elle est là."""
    try:
        import zee_local
        zee_local.start_background(asyncio.get_running_loop())
    except Exception:
        pass
    try:
        import ici_warm
        ici_warm.start_background(asyncio.get_running_loop())
    except Exception:
        pass


@app.get("/ici/warm/status")
def ici_warm_status():
    """Où en est la pré-génération des perles de la route officielle (+ la couche ZEE locale)."""
    import ici_warm
    import zee_local
    return {**ici_warm.status(), "zeeLocal": zee_local.status()}


@app.get("/ici/pearls")
def ici_pearls():
    """Les perles canoniques de la route officielle (12 nm) : le client les
    échantillonne aux mêmes positions, ses sacs thin tombent dans le cache."""
    import ici_warm
    return ici_warm.official_pearls()


class PositionRequest(BaseModel):
    latitude: float
    longitude: float


def _copernicus_ready() -> bool:
    return bool(
        COPERNICUS_USERNAME
        and COPERNICUS_PASSWORD
        and get_wind_data_at_position
        and get_wave_data_at_position
        and get_current_data_at_position
    )


def _is_estimated(record: dict | None) -> bool:
    data = (record or {}).get("data") or {}
    return bool(data.get("simulation")) or str(data.get("source") or "").startswith("estimated")


def _mark_live(data: dict) -> dict:
    out = dict(data)
    out.pop("simulation", None)
    out["source"] = "copernicus-marine"
    return out


def _force_estimated(kind: str, lat: float, lon: float) -> bool:
    if not _copernicus_ready():
        return False
    return _is_estimated(get_pipeline().peek(kind, lat, lon))


def _weather_snapshot(kind: str, request: PositionRequest, loader) -> dict:
    lat, lon = request.latitude, request.longitude
    return get_pipeline().snapshot(
        kind, lat, lon, lambda: loader(request), force=_force_estimated(kind, lat, lon),
    )


@app.get("/")
def health():
    return {"service": "naviguide-simulator", "version": "0.2.0"}


@app.get("/ici")
async def get_ici(
    lat: float = Query(...),
    lon: float = Query(...),
    radius_nm: float = Query(ICI_RADIUS_NM, ge=5, le=40),
    month: int | None = Query(None, ge=1, le=12),
    dest_lat: float | None = Query(None),
    dest_lon: float | None = Query(None),
    thin: bool = Query(False),
):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon hors limites")
    if dest_lat is not None and not (-90 <= dest_lat <= 90):
        raise HTTPException(400, "dest_lat hors limites")
    if dest_lon is not None and not (-180 <= dest_lon <= 180):
        raise HTTPException(400, "dest_lon hors limites")
    return await fill_dossier(
        lat, lon, radius_nm, month=month, dest_lat=dest_lat, dest_lon=dest_lon, thin=thin,
    )


# Dépense LLM : 12 récits / min / IP, 60 / min et 240 / h pour tout le serveur.
# Le client tombe sur la phrase locale en cas de 429 (storyQueue → failed).
_story_limited = rate_limited("story", 12, 60.0, global_limit=60)
_story_hourly = rate_limited("story-hour", 10**9, 3600.0, global_limit=240)
_weather_limited = rate_limited("weather", 90, 60.0)


@app.post("/ici/story", dependencies=[Depends(_story_limited), Depends(_story_hourly)])
async def post_ici_story(body: dict):
    """Background story. NIM → OR ± :online → Claude. Play does not await this."""
    if not isinstance(body, dict) or not (body.get("event") or body.get("eventId")):
        raise HTTPException(400, "événement manquant")
    if len(str(body)) > 60_000:
        raise HTTPException(413, "événement trop volumineux")
    return await write_story(body)


@app.get("/route")
def get_route(
    start_lat: float = Query(...),
    start_lon: float = Query(...),
    end_lat: float = Query(...),
    end_lon: float = Query(...),
    check_wind: bool = Query(False),
):
    start = (start_lon, start_lat)
    end = (end_lon, end_lat)
    try:
        route = searoute_with_exact_end(start, end)
        if route is None:
            raise HTTPException(status_code=404, detail="Route non trouvée")
        return route
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _sim_wind(lat: float, lon: float) -> dict:
    import datetime
    import random

    rng = random.Random(int(abs(lat * 100) + abs(lon * 100)))
    speed_ms = rng.uniform(3, 18)
    direction = round(rng.uniform(0, 360), 1)
    u = round(-speed_ms * math.sin(math.radians(direction)), 3)
    v = round(-speed_ms * math.cos(math.radians(direction)), 3)
    return {
        "latitude": lat,
        "longitude": lon,
        "u_component": u,
        "v_component": v,
        "wind_speed": round(speed_ms, 2),
        "wind_speed_kmh": round(speed_ms * 3.6, 1),
        "wind_speed_knots": round(speed_ms * 1.944, 1),
        "wind_direction": direction,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "simulation": True,
        "source": "estimated (Copernicus unavailable)",
    }


def _sim_wave(lat: float, lon: float) -> dict:
    import datetime
    import random

    rng = random.Random(int(abs(lat * 137) + abs(lon * 73)))
    return {
        "latitude": lat,
        "longitude": lon,
        "significant_wave_height_m": round(rng.uniform(0.3, 4.5), 2),
        "mean_wave_period": round(rng.uniform(4, 14), 1),
        "mean_wave_direction": round(rng.uniform(0, 360), 1),
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "simulation": True,
        "source": "estimated (Copernicus unavailable)",
    }


def _sim_current(lat: float, lon: float) -> dict:
    import datetime
    import random

    rng = random.Random(int(abs(lat * 211) + abs(lon * 157)))
    speed_ms = rng.uniform(0.05, 1.2)
    direction = round(rng.uniform(0, 360), 1)
    return {
        "latitude": lat,
        "longitude": lon,
        "u_component": round(speed_ms * math.sin(math.radians(direction)), 4),
        "v_component": round(speed_ms * math.cos(math.radians(direction)), 4),
        "speed_ms": round(speed_ms, 3),
        "speed_knots": round(speed_ms * 1.944, 2),
        "speed_kmh": round(speed_ms * 3.6, 2),
        "direction_deg": direction,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "simulation": True,
        "source": "estimated (Copernicus unavailable)",
    }


def _load_wind(request: PositionRequest) -> dict:
    try:
        if COPERNICUS_USERNAME and COPERNICUS_PASSWORD and get_wind_data_at_position:
            wind_data = get_wind_data_at_position(
                latitude=request.latitude,
                longitude=request.longitude,
                username=COPERNICUS_USERNAME,
                password=COPERNICUS_PASSWORD,
            )
            if wind_data is not None:
                return _mark_live(wind_data)
    except Exception as exc:
        print(f"⚠️  Copernicus vent: {type(exc).__name__}: {exc}")
    return _sim_wind(request.latitude, request.longitude)


def _load_wave(request: PositionRequest) -> dict:
    try:
        if COPERNICUS_USERNAME and COPERNICUS_PASSWORD and get_wave_data_at_position:
            wave_data = get_wave_data_at_position(
                latitude=request.latitude,
                longitude=request.longitude,
                username=COPERNICUS_USERNAME,
                password=COPERNICUS_PASSWORD,
            )
            if wave_data is not None:
                return _mark_live(wave_data)
    except Exception as exc:
        print(f"⚠️  Copernicus vague: {type(exc).__name__}: {exc}")
    return _sim_wave(request.latitude, request.longitude)


def _load_current(request: PositionRequest) -> dict:
    try:
        if COPERNICUS_USERNAME and COPERNICUS_PASSWORD and get_current_data_at_position:
            current_data = get_current_data_at_position(
                latitude=request.latitude,
                longitude=request.longitude,
                username=COPERNICUS_USERNAME,
                password=COPERNICUS_PASSWORD,
            )
            if current_data is not None:
                return _mark_live(current_data)
    except Exception as exc:
        print(f"⚠️  Copernicus courant: {type(exc).__name__}: {exc}")
    return _sim_current(request.latitude, request.longitude)


@app.post("/wind", dependencies=[Depends(_weather_limited)])
def get_wind(request: PositionRequest):
    return _weather_snapshot("wind", request, _load_wind)


@app.post("/wave", dependencies=[Depends(_weather_limited)])
def get_wave(request: PositionRequest):
    return _weather_snapshot("wave", request, _load_wave)


@app.post("/current", dependencies=[Depends(_weather_limited)])
def get_current(request: PositionRequest):
    return _weather_snapshot("current", request, _load_current)


@app.post("/weather", dependencies=[Depends(_weather_limited)])
def get_weather(request: PositionRequest):
    """Réponse immédiate : vent / vague / courant, cache cellule + cycle."""
    lat, lon = request.latitude, request.longitude
    force = any(_force_estimated(kind, lat, lon) for kind in ("wind", "wave", "current"))
    return get_pipeline().snapshot_group(
        (
            ("wind", "wind", lambda: _load_wind(PositionRequest(latitude=lat, longitude=lon))),
            ("wave", "wave", lambda: _load_wave(PositionRequest(latitude=lat, longitude=lon))),
            ("current", "current", lambda: _load_current(PositionRequest(latitude=lat, longitude=lon))),
        ),
        lat,
        lon,
        force=force,
    )


@app.get("/weather/forecast")
def get_forecast_weather(lat: float = Query(...), lon: float = Query(...)):
    """Sac ICI Open-Meteo + RTOFS, même pipeline (pending immédiat)."""
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon hors limites")
    from ici_layers import snapshot_ici_weather
    return snapshot_ici_weather(lat, lon)


_WPI_CACHE_TTL = 86_400
_zee_cache: dict = {"entries": {}}
_ZEE_CACHE_TTL = 86_400
_VLIZ_WMS = "https://geo.vliz.be/geoserver/MarineRegions/wms"
_CATALOG_SOURCE_TTL = 900.0
_CATALOG_UPSTREAM = os.getenv(
    "NAVIGUIDE_CATALOG_UPSTREAM",
    os.getenv("BI_API_URL") or "https://blueintelligence.online/api",
).rstrip("/")
_CATALOG_PATHS = {
    "projects": "/export/geojson",
    "marinas": "/export/marinas.geojson",
    "capitaineries": "/export/capitaineries.geojson",
    "poe": "/export/poe.geojson",
    "amp": "/export/amp.geojson",
    "science": "/export/science.geojson",
}
_catalog_cache: dict[str, dict] = {}
_catalog_tasks: dict[str, asyncio.Task] = {}
_WMS_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=21600, stale-while-revalidate=86400",
}
_SEAMARK_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
}

_DMS_RE = re.compile(
    r"""(\d+)\s*[°d]\s*(\d+)\s*[''′]\s*(\d+(?:\.\d+)?)\s*[""″]?\s*([NSEW]?)""",
    re.IGNORECASE,
)


def _parse_coord(value: Optional[Union[str, float, int]]) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        pass
    m = _DMS_RE.search(s)
    if m:
        deg, mins, secs, hemi = m.groups()
        decimal = float(deg) + float(mins) / 60.0 + float(secs) / 3600.0
        if hemi.upper() in ("S", "W"):
            decimal = -decimal
        return decimal
    return None


@app.get("/proxy/zee/wms")
async def proxy_zee_wms(request: Request):
    params = dict(request.query_params)
    bbox = params.get("bbox") or params.get("BBOX")
    if not bbox:
        raise HTTPException(status_code=400, detail="Missing bbox parameter")
    params.setdefault("service", "WMS")
    params.setdefault("version", "1.1.1")
    params.setdefault("request", "GetMap")
    params["layers"] = "eez_boundaries"
    params.setdefault("format", "image/png")
    params.setdefault("transparent", "true")
    params.setdefault("srs", "EPSG:3857")
    params.setdefault("width", "512")
    params.setdefault("height", "512")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(_VLIZ_WMS, params=params)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"VLIZ WMS HTTP {resp.status_code}")
            return Response(content=resp.content, media_type="image/png", headers=_WMS_CACHE_HEADERS)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ZEE WMS error: {exc}") from exc


@app.get("/proxy/zee")
async def proxy_zee(
    bbox: Optional[str] = Query(None),
    maxFeatures: int = Query(80, ge=1, le=ZEE_MAX_FEATURES_CAP),
):
    if not bbox and maxFeatures > ZEE_NO_BBOX_MAX_FEATURES:
        raise HTTPException(400, "bbox (minlon,minlat,maxlon,maxlat) requis pour les ZEE")
    cache_key = bbox or f"nobbox:{maxFeatures}"
    cached = _zee_cache.get("entries") or {}
    hit = cached.get(cache_key)
    if hit and (time.time() - hit["ts"] < _ZEE_CACHE_TTL):
        return JSONResponse(content=hit["data"])
    params: dict = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typeName": "eez",
        "outputFormat": "application/json",
        "maxFeatures": maxFeatures,
    }
    if bbox:
        params["bbox"] = bbox
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.get(
                "https://geo.vliz.be/geoserver/MarineRegions/wfs",
                params=params,
            )
            resp.raise_for_status()
            raw = resp.content or b""
            if too_large(len(raw), ZEE_RESPONSE_MAX_BYTES):
                raise HTTPException(502, f"ZEE upstream trop volumineux ({len(raw)} octets)")
            data = resp.json()
            if bbox and not too_large(len(raw), ZEE_CACHE_MAX_BYTES):
                lru_set(_zee_cache.setdefault("entries", {}), cache_key, {"data": data, "ts": time.time()}, max_items=4)
            return JSONResponse(content=data)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ZEE upstream error: {exc}") from exc


def _parse_ports_bbox(raw: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    try:
        bbox = parse_bbox(raw)
    except ValueError as exc:
        raise HTTPException(400, "bbox ports invalide") from exc
    return None if bbox is None else (bbox.west, bbox.south, bbox.east, bbox.north)


def _port_in_bbox(feature: dict, bbox: Optional[tuple[float, float, float, float]]) -> bool:
    if bbox is None:
        return True
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2:
        return False
    lon, lat = float(coords[0]), float(coords[1])
    west, south, east, north = bbox
    if lat < south or lat > north:
        return False
    copies = (lon - 360.0, lon, lon + 360.0)
    if west <= east:
        return any(west <= value <= east for value in copies)
    return any(value >= west or value <= east for value in copies)


async def _fetch_catalog_features(catalog: str) -> list[dict]:
    """Lit une source explicitement autorisée; aucune URL utilisateur n'est proxifiée."""
    if catalog == "ports":
        return await fetch_wpi_features()
    path = _CATALOG_PATHS.get(catalog)
    if not path:
        raise KeyError(catalog)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{_CATALOG_UPSTREAM}{path}", headers={"Accept": "application/geo+json, application/json"})
        response.raise_for_status()
        if too_large(len(response.content), ZEE_RESPONSE_MAX_BYTES):
            raise ValueError("catalogue source trop volumineux")
        payload = response.json()
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise ValueError("catalogue source GeoJSON invalide")
    return features


async def _load_catalog_index(catalog: str) -> SpatialCatalogIndex:
    now = time.monotonic()
    cached = _catalog_cache.get(catalog)
    if cached and now - cached["at"] < _CATALOG_SOURCE_TTL:
        return cached["index"]

    task = _catalog_tasks.get(catalog)
    if task is None:
        task = asyncio.create_task(_fetch_catalog_features(catalog))
        _catalog_tasks[catalog] = task
    try:
        features = await asyncio.shield(task)
    except Exception:
        if cached:
            return cached["index"]
        raise
    finally:
        if _catalog_tasks.get(catalog) is task and task.done():
            _catalog_tasks.pop(catalog, None)

    index = SpatialCatalogIndex(catalog, features)
    _catalog_cache[catalog] = {"at": time.monotonic(), "index": index}
    return index


async def _catalog_feature_collection(
    catalog: str,
    bbox: Optional[str],
    zoom: float,
    limit: int,
    source: Optional[str] = None,
) -> dict:
    if catalog != "ports" and catalog not in _CATALOG_PATHS:
        raise HTTPException(404, "catalogue inconnu")
    try:
        parsed_bbox = parse_bbox(bbox)
    except ValueError as exc:
        raise HTTPException(400, "bbox catalogue invalide") from exc
    if parsed_bbox is None:
        raise HTTPException(400, "bbox (minlon,minlat,maxlon,maxlat) requise")
    try:
        index = await _load_catalog_index(catalog)
    except KeyError as exc:
        raise HTTPException(404, "catalogue inconnu") from exc
    except ValueError as exc:
        raise HTTPException(502, detail=f"catalogue source invalide: {exc}") from exc
    except Exception as exc:
        raise HTTPException(502, detail=f"catalogue source indisponible: {exc}") from exc
    return index.query(parsed_bbox, zoom=zoom, limit=limit, source=source)


@app.get("/proxy/catalog/{catalog}")
async def proxy_catalog(
    catalog: str,
    bbox: str = Query(...),
    zoom: float = Query(2, ge=0, le=18),
    limit: int = Query(MAX_RENDER_FEATURES, ge=1, le=MAX_RENDER_FEATURES),
    source: Optional[str] = Query(None, max_length=40),
):
    """API bbox locale pour les catalogues affichés par le simulateur."""
    data = await _catalog_feature_collection(catalog, bbox, zoom, limit, source)
    return JSONResponse(
        content=data,
        headers={"Cache-Control": "public, max-age=180, stale-while-revalidate=600"},
    )


@app.get("/proxy/ports")
async def proxy_ports(
    bbox: str = Query(...),
    zoom: float = Query(2, ge=0, le=18),
    limit: int = Query(MAX_RENDER_FEATURES, ge=1, le=MAX_RENDER_FEATURES),
):
    # Compatibilité de l'URL historique, désormais servie par le même index.
    visible = await _catalog_feature_collection("ports", bbox, zoom, limit)
    return JSONResponse(
        content=visible,
        headers={"Cache-Control": "public, max-age=180, stale-while-revalidate=600"},
    )


_OPENSEAMAP_HOSTS = ["tiles.openseamap.org", "t1.openseamap.org"]


def _transparent_tile_256() -> bytes:
    try:
        import io
        from PIL import Image

        img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()
    except ImportError:
        return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"


_TRANSPARENT_TILE = None


def _get_transparent_tile() -> bytes:
    global _TRANSPARENT_TILE
    if _TRANSPARENT_TILE is None:
        _TRANSPARENT_TILE = _transparent_tile_256()
    return _TRANSPARENT_TILE


@app.get("/proxy/seamark/{z:int}/{x:int}/{y}.png")
async def proxy_seamark(z: int, x: int, y: str):
    try:
        y_int = int(y)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid tile y")
    async with httpx.AsyncClient(timeout=12.0) as client:
        for host in _OPENSEAMAP_HOSTS:
            url = f"https://{host}/seamark/{z}/{x}/{y_int}.png"
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return Response(content=resp.content, media_type="image/png", headers=_SEAMARK_CACHE_HEADERS)
            except Exception:
                continue
    return Response(content=_get_transparent_tile(), media_type="image/png", headers=_SEAMARK_CACHE_HEADERS)
