import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redo2, Undo2, X } from "lucide-react";
import { Sidebar } from "./components/Sidebar.jsx";
import { ToolsSidebar } from "./components/ToolsSidebar.jsx";
import { LayerFichePopup } from "./components/LayerFichePopup.jsx";
import NotForNavModal from "./components/NotForNavModal.jsx";
import { readNotForNavAccepted, writeNotForNavAccepted } from "./utils/notForNav.js";
import { SatelliteMetPanel } from "./components/SatelliteMetPanel.jsx";
import { useLang } from "./i18n/LangContext.jsx";
import { ITINERARY_POINTS } from "./constants/itineraryPoints";
import { SimulationFilmBar } from "./components/SimulationFilmBar.jsx";
import { RecomputeDialog } from "./components/RecomputeDialog.jsx";
import { useRouteWindProfile } from "./hooks/useRouteWindProfile.js";
import { useExpeditionSpeed } from "./hooks/useExpeditionSpeed.js";
import { useVoyageClock } from "./hooks/useVoyageClock.js";
import { useVirtualVessel } from "./hooks/useVirtualVessel.js";
import { useOfficialExpedition } from "./hooks/useOfficialExpedition.js";
import { useOfficialJournal } from "./hooks/useOfficialJournal.js";
import { useIciDossier } from "./hooks/useIciDossier.js";
import { useIciAlong } from "./hooks/useIciAlong.js";
import { useMomentCards } from "./hooks/useMomentCards.js";
import { useEscaleSheet } from "./hooks/useEscaleSheet.js";
import { useLogbookChat } from "./hooks/useLogbookChat.js";
import { FreeMomentBlock, MomentNowCard } from "./components/MomentCards.jsx";
import { dayMonth, expeditionStory } from "./engine/expeditionStory.js";
import { sumRainHours } from "./engine/eventRules.js";
import { layerForEntity } from "./engine/briefingLinks.js";
import { useSkipperOrders } from "./hooks/useSkipperOrders.js";
import { filmEventMarks } from "./engine/iciAlong.js";
import { useAtlasLookup } from "./hooks/useAtlasLookup.js";
import { recetteMapView, recetteMonth } from "./utils/recetteQuery.js";
import {
  flattenRoute,
  interpolateAtNm,
  nearestNm,
  mapEscalesOnRoute,
  nextEscaleNm,
  prevEscaleNm,
  filmLegContext,
  chapterAtNm,
} from "./engine/routePlayhead.js";
import { detectAirEpisodes, mergeEpisodeMarks, sailNmToFilmNm } from "./engine/filmCast.js";
import { expeditionBoatKnots } from "./engine/playSpeeds.js";
import {
  DEFAULT_START_AT,
  etaHoursToFilmNm,
  formatFilmClockLine,
  formatMonthName,
  lookupVoyageClock,
  monthOfT0,
} from "./engine/voyageClock.js";
import { VIEW_SIMULATION, VIEW_SUIVRE } from "./constants/viewMode.js";
import { isRouteReady } from "./utils/routeReady.js";
import {
  isSceneReady,
  playheadAligned,
  sceneMaskKey,
  shouldFocusSimulationJump,
  shouldKeepSceneVisible,
} from "./utils/sceneGate.js";
import { summarizeRoute, featuresToSegments, haversineNm } from "./utils/geo.js";
import { waypointsFromCollection } from "./utils/waypointsFromCollection.js";
import { buildLocalCustomBriefing } from "./utils/customRouteBriefing.js";
import { normalizeExpeditionPlan } from "./utils/expeditionPlan.js";
import {
  activeSimulationSegments,
  activeSimulationStops,
} from "./utils/simulationRoute.js";
import {
  SEGMENT_BATCH_SIZE,
  buildBerryLegs,
  coordsFromRoutePayload,
  isNonMaritimeLeg,
  orientCoords,
} from "./utils/berryLegs.js";
import { loadOfficialBerryRoute } from "./utils/routeFromOfficial.js";
import { isCinemaKey } from "./utils/cinemaHotkey.js";
import { weatherLine as buildWeatherLine } from "./utils/weatherLine.js";
import { mapInsetVars } from "./utils/filmBarLayout.js";
import {
  fetchWeatherComposite,
  productHasData,
  satelliteBusy,
  weatherPollMs,
} from "./hooks/weatherSnapshot.js";
import { MapScene } from "./map/MapScene.jsx";

const API_URL = import.meta.env.VITE_API_URL ?? "";
const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL;
const PLAN_CACHE_TTL = 24 * 60 * 60 * 1000;
const NOOP = () => {};
const EMPTY_MARITIME_LAYERS = Object.freeze({
  showGrib: false, setShowGrib: NOOP, loadingGrib: false, errorGrib: null,
  showZee: false, setShowZee: NOOP, loadingZee: false, errorZee: null,
  showPorts: false, setShowPorts: NOOP, loadingPorts: false, errorPorts: null,
  showBalisage: false, setShowBalisage: NOOP, loadingBalisage: false, errorBalisage: null,
  showBiProjects: false, setShowBiProjects: NOOP, loadingBiProjects: false, errorBiProjects: null,
  showBiMarinas: false, setShowBiMarinas: NOOP, loadingBiMarinas: false, errorBiMarinas: null,
  showBiCapitaineries: false, setShowBiCapitaineries: NOOP, loadingBiCapitaineries: false, errorBiCapitaineries: null,
  showBiPoe: false, setShowBiPoe: NOOP, loadingBiPoe: false, errorBiPoe: null,
  showBiAmp: false, setShowBiAmp: NOOP, loadingBiAmp: false, errorBiAmp: null,
  showSextant: false, setShowSextant: NOOP, showArgo: false, setShowArgo: NOOP,
  showOdatis: false, setShowOdatis: NOOP, showEdmed: false, setShowEdmed: NOOP,
  showCsr: false, setShowCsr: NOOP, loadingScienceCatalog: false, errorScienceCatalog: null,
  showBathymetry: false, setShowBathymetry: NOOP, loadingBathymetry: false, errorBathymetry: null,
  showFonds: false, setShowFonds: NOOP, loadingFonds: false, errorFonds: null,
  showCables: false, setShowCables: NOOP, loadingCables: false, errorCables: null,
  showClimoWind: false, setShowClimoWind: NOOP, showClimoWave: false, setShowClimoWave: NOOP,
  showClimoCurrent: false, setShowClimoCurrent: NOOP, showClimoCyclones: false, setShowClimoCyclones: NOOP,
});

function planCacheKey(lang) { return `naviguide_sim_plan_v1_${lang}`; }
function getCachedPlan(lang) {
  try {
    const raw = localStorage.getItem(planCacheKey(lang));
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > PLAN_CACHE_TTL) { localStorage.removeItem(planCacheKey(lang)); return null; }
    return normalizeExpeditionPlan(data);
  } catch { return null; }
}
function setCachedPlan(lang, data) {
  const plan = normalizeExpeditionPlan(data);
  if (!plan) return;
  try { localStorage.setItem(planCacheKey(lang), JSON.stringify({ data: plan, ts: Date.now() })); } catch { /* quota */ }
}

export default function App() {
  const { lang, t } = useLang();
  const sceneApiRef = useRef(null);
  const [sceneApi, setSceneApi] = useState(null);
  const [playback, setPlayback] = useState({
    nm: 0,
    playing: false,
    profile: "normal",
    jumpToken: 0,
    holdingStation: null,
    holding: false,
    totalNm: 0,
    sailTotalNm: 0,
  });
  const [maritimeLayerState, setMaritimeLayerState] = useState(null);
  const maritimeLayers = maritimeLayerState || EMPTY_MARITIME_LAYERS;
  const [climoLayer, setClimoLayer] = useState({ loading: false, error: null, counts: null });
  const [isLightMode, setIsLightMode] = useState(false);

  const [segments, setSegments] = useState([]);
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [segProgress, setSegProgress] = useState({ done: 0, total: 0 });
  const [officialFallback, setOfficialFallback] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [expeditionPlan, setExpeditionPlan] = useState(null);
  const [polarData, setPolarData] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

  const [view, setView] = useState(VIEW_SIMULATION);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [hideFilmBar, setHideFilmBar] = useState(false);
  const [stopAuto, setStopAuto] = useState(false);
  const [cameraFollow, setCameraFollow] = useState(false);
  const [cinemaRecapture, setCinemaRecapture] = useState(0);
  const [cameraFocusToken, setCameraFocusToken] = useState(0);
  const [userPreview, setUserPreview] = useState(false);
  const [skipperClickId, setSkipperClickId] = useState(null);
  const isSuivre = view === VIEW_SUIVRE;
  const isSimulation = view === VIEW_SIMULATION;
  const [voyageFlat, setVoyageFlat] = useState(null);
  const [cameraPlaced, setCameraPlaced] = useState(false);
  const [sceneRevealed, setSceneRevealed] = useState(false);
  const [liveKnots, setLiveKnots] = useState(null);
  const cinemaSavedRef = useRef({ sidebar: true, tools: true });
  const drawRestoreRef = useRef({ view: VIEW_SUIVRE, center: null, zoom: null });
  const [customRoute, setCustomRoute] = useState(null);
  const [routeKind, setRouteKind] = useState("berry");
  const routeKindRef = useRef("berry");
  const berryFetchIdRef = useRef(0);
  const customFetchIdRef = useRef(0);

  const [drawingMode, setDrawingMode] = useState(false);
  const [drawnPoints, setDrawnPoints] = useState([]);
  const [drawnSegments, setDrawnSegments] = useState([]);
  const [drawingLoading, setDrawingLoading] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const drawnPointsRef = useRef([]);
  const drawnSegmentsRef = useRef([]);
  const undonePointsRef = useRef([]);
  const undoneSegmentsRef = useRef([]);
  const fetchIdRef = useRef(0);

  const [layerPopup, setLayerPopup] = useState(null);
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [clipboardToast, setClipboardToast] = useState(null);
  const [selectedSatellite, setSelectedSatellite] = useState(null);
  const [satelliteLoading, setSatelliteLoading] = useState(false);
  const [satelliteTab, setSatelliteTab] = useState("wind");
  const [pointInfoName, setPointInfoName] = useState("");
  const [pointInfoFlags, setPointInfoFlags] = useState([null, null]);
  const satelliteRequestRef = useRef({ id: 0, controller: null });

  const cancelSatelliteRequest = useCallback(() => {
    satelliteRequestRef.current.id += 1;
    satelliteRequestRef.current.controller?.abort();
    satelliteRequestRef.current.controller = null;
  }, []);
  const closeSatellite = useCallback(() => {
    cancelSatelliteRequest();
    setSelectedSatellite(null);
    setSatelliteLoading(false);
  }, [cancelSatelliteRequest]);

  const onFeature = useCallback((fiche) => {
    closeSatellite();
    setLayerPopup(fiche);
  }, [closeSatellite]);
  const handleSceneReady = useCallback((api) => {
    sceneApiRef.current = api;
    setSceneApi(api);
  }, []);
  const handleScenePlayback = useCallback((snapshot) => {
    setPlayback(snapshot);
  }, []);
  const handleLayerState = useCallback((layers) => {
    setMaritimeLayerState(layers);
  }, []);
  const handleClimatologyState = useCallback((state) => {
    setClimoLayer((previous) => (
      previous.loading === state.loading
      && previous.error === state.error
      && previous.counts === state.counts
        ? previous
        : state
    ));
  }, []);
  const handleCoordinatesCopied = useCallback((text) => {
    navigator.clipboard.writeText(text).then(() => {
      setClipboardToast(text);
      setTimeout(() => setClipboardToast(null), 2000);
    });
  }, []);
  const handleDrawingWaypointClick = useCallback((point, index) => {
    setPointInfoName(point?.name || "");
    setPointInfoFlags(point?.flags || []);
    setSelectedSatellite({
      lat: point?.lat,
      lon: point?.lon,
      drawPointIndex: index,
    });
  }, []);
  const [notForNavOk, setNotForNavOk] = useState(() => readNotForNavAccepted());
  const [notForNavOpen, setNotForNavOpen] = useState(false);
  const pendingLayerRef = useRef(null);
  const gateRef = useRef({
    allowed: notForNavOk,
    onNeed: (kind) => {
      pendingLayerRef.current = kind;
      setNotForNavOpen(true);
    },
  });
  gateRef.current.allowed = notForNavOk;

  const routeForView = isSuivre ? null : customRoute;
  const routeReady = isRouteReady(segProgress) || (officialFallback && segments.length > 0);
  const activeStops = useMemo(() => activeSimulationStops(routeForView, points.length ? points : ITINERARY_POINTS), [routeForView, points]);
  const activeSegments = useMemo(() => activeSimulationSegments(routeForView, segments), [routeForView, segments]);
  const baseFlat = useMemo(() => flattenRoute(activeSegments), [activeSegments]);
  const flatRoute = voyageFlat || baseFlat;
  const escaleMarks = useMemo(
    () => mergeEpisodeMarks(mapEscalesOnRoute(activeStops, flatRoute), flatRoute, activeStops),
    [activeStops, flatRoute],
  );
  const cruiseKnots = useMemo(() => expeditionBoatKnots(polarData), [polarData]);
  const atlasWindRef = useRef(null);
  const [atlasRev, setAtlasRev] = useState(0);
  const atlasWindAt = useCallback((lat, lon, month) => {
    if (typeof atlasWindRef.current === "function") {
      return atlasWindRef.current(lat, lon, month);
    }
    return null;
  }, []);
  const voyage = useVoyageClock({
    flat: flatRoute,
    marks: escaleMarks,
    polarRaw: polarData?.raw || null,
    enabled: Boolean(flatRoute.points?.length) && routeReady,
    stops: activeStops,
    windAt: atlasWindAt,
    atlasRev,
    mode: isSuivre ? "suivre" : "simulation",
  });
  const official = useOfficialExpedition({
    enabled: isSuivre,
    points: routeReady ? flatRoute.points : undefined,
    marks: routeReady ? escaleMarks : [],
    expeditionId: polarData?.expedition_id,
    clock: voyage.clock,
  });
  // Mémoire du voyage officiel (journal serveur) — lecture seule, Suivre.
  const officialJournal = useOfficialJournal({ enabled: isSuivre });
  const vessel = useVirtualVessel({
    enabled: isSimulation && routeReady,
    forecast: false,
    follow: false,
    t0: voyage.t0,
    startAt: voyage.startAt,
    expeditionId: polarData?.expedition_id,
    routeKind,
    points: flatRoute.points,
    marks: escaleMarks,
  });
  const officialClock = voyage.clock || official.clock;
  const boatKnots = liveKnots > 0 ? liveKnots : cruiseKnots;

  const live = isSuivre ? official.live : vessel.live;
  const previewing = Boolean(isSuivre && live && userPreview);
  const playheadReady = playheadAligned({
    isSuivre,
    previewing,
    playbackNm: playback.nm,
    liveFilmNm: live?.filmNm,
  });
  const hasRoute = Boolean(flatRoute.points?.length);
  const gateReady = isSceneReady({
    routeReady,
    hasRoute,
    cameraPlaced,
    playheadReady,
    isSuivre,
    hasLive: Boolean(live),
    previewing,
  });
  const sceneReady = gateReady || shouldKeepSceneVisible({
    revealed: sceneRevealed,
    routeReady,
    hasRoute,
  });
  const clockSample = useMemo(() => {
    if (isSuivre && live && !previewing) return live;
    return lookupVoyageClock(officialClock, playback.nm, { atQuay: playback.holding });
  }, [isSuivre, live, previewing, officialClock, playback.nm, playback.holding]);
  const windProfile = useRouteWindProfile({
    flat: flatRoute,
    marks: escaleMarks,
    polarData,
    cruiseKnots,
    enabled: Boolean(officialClock),
    clock: officialClock,
  });

  const cast = playback.cast;
  const sample = useMemo(() => {
    if (!cast) return interpolateAtNm(flatRoute, playback.nm);
    const actor = cast.vehicle === "side" ? cast.side : cast.main;
    return {
      lat: actor.lat,
      lon: actor.lon,
      bearing: actor.bearing,
      nm: cast.sailNm,
    };
  }, [cast, flatRoute, playback.nm]);

  // Skipper orders: one character, boat read from the polar, saved in this tab.
  // Cinema keeps them active. The planning speed reads the polar at the wind
  // of the moment: GRIB at the boat in Suivre, climatology of the clock in Simulation.
  const skipperWind = isSuivre
    ? (live?.kind === "forecast" && Number.isFinite(live.windKnots)
      ? { tws: live.windKnots, twd: live.dirFromDeg, heading: live.bearing ?? sample?.bearing, kind: "grib" }
      : null)
    : (Number.isFinite(clockSample?.windKnots)
      ? { tws: clockSample.windKnots, twd: clockSample.dirFromDeg, heading: sample?.bearing ?? clockSample.bearing, kind: "climatology" }
      : null);
  const skipper = useSkipperOrders({
    polar: polarData,
    mode: isSuivre ? "suivre" : "simulation",
    lang,
    wind: skipperWind,
  });

  const destMark = useMemo(
    () => chapterAtNm(escaleMarks, cast?.sailNm ?? playback.nm)?.to,
    [escaleMarks, cast?.sailNm, playback.nm],
  );
  const climoMonth = recetteMonth() || clockSample?.month || monthOfT0(voyage.t0, 0);
  const atlas = useAtlasLookup({
    enabled: routeReady,
    t0: voyage.t0,
    points: flatRoute.points,
    boatLat: sample?.lat,
    boatLon: sample?.lon,
    destLat: destMark?.lat,
    destLon: destMark?.lon,
    month: climoMonth,
  });
  useEffect(() => {
    atlasWindRef.current = atlas.windAt;
    if (atlas.revision !== atlasRev) setAtlasRev(atlas.revision);
  }, [atlas.windAt, atlas.revision, atlasRev]);

  const climoAnyOn = Boolean(
    maritimeLayers.showClimoWind
    || maritimeLayers.showClimoWave
    || maritimeLayers.showClimoCurrent
    || maritimeLayers.showClimoCyclones,
  );
  const climoMapsLabel = [
    maritimeLayers.showClimoWind && t("layerClimoWind"),
    maritimeLayers.showClimoWave && t("layerClimoWave"),
    maritimeLayers.showClimoCurrent && t("layerClimoCurrent"),
    maritimeLayers.showClimoCyclones && t("layerClimoCyclones"),
  ].filter(Boolean).join(" · ");

  const expeditionSpeed = useExpeditionSpeed({
    polarData,
    sample: cast?.vehicle === "plane" ? cast.main : sample,
    profile: playback.profile,
    playing: playback.playing && cast?.vehicle !== "plane",
    onLiveKnots: setLiveKnots,
    windSeries: windProfile.series,
    filmNm: playback.nm,
    clockSample,
    clockReady: Boolean(officialClock),
  });
  const legContext = useMemo(() => {
    if (!cast) return null;
    return filmLegContext({
      marks: escaleMarks,
      nm: cast.sailNm,
      sample,
      totalNm: playback.sailTotalNm || flatRoute.totalNm,
      boatKnots: expeditionSpeed.knots,
      cast,
    });
  }, [cast, sample, escaleMarks, playback.sailTotalNm, flatRoute.totalNm, expeditionSpeed.knots]);

  const clockEtaHours = useMemo(() => {
    if (!officialClock || !legContext || legContext.finished || (legContext.nmRemainingToStop ?? 0) < 0.5) {
      return 0;
    }
    const destNm = legContext.chapter?.to?.filmNm ?? legContext.chapter?.to?.nm;
    if (destNm == null) return legContext.etaHours;
    return etaHoursToFilmNm(officialClock, playback.nm, destNm, { atQuay: playback.holding })
      ?? legContext.etaHours;
  }, [officialClock, legContext, playback.nm, playback.holding]);

  const hudLeg = useMemo(() => {
    if (!legContext) return null;
    const local = Number(clockSample?.speedKnots);
    const sailing = clockSample
      && (clockSample.vehicle === "main" || clockSample.vehicle === "side")
      && Number.isFinite(local);
    return {
      ...legContext,
      etaHours: officialClock ? clockEtaHours : legContext.etaHours,
      speedKnots: sailing ? Math.round(local * 10) / 10 : (officialClock ? null : legContext.speedKnots),
        kind: clockSample?.kind === "forecast"
          ? "forecast"
          : (isSuivre ? "absent" : (clockSample?.kind || (officialClock ? "climatology" : legContext.kind))),
    };
  }, [legContext, clockSample, officialClock, clockEtaHours, isSuivre]);

  const jambe = useMemo(() => {
    if (!hudLeg) return null;
    return {
      fromStop: hudLeg.fromStop,
      toStop: hudLeg.toStop,
      speedKnots: hudLeg.speedKnots,
      etaHours: hudLeg.etaHours,
      remainingNm: hudLeg.nmRemainingToStop ?? hudLeg.remainingNm,
      phase: hudLeg.phase,
      vehicle: hudLeg.vehicle,
    };
  }, [hudLeg]);

  const legendMarks = useMemo(() => {
    const clockMarks = officialClock?.marks || [];
    return escaleMarks.map((m) => {
      const film = m.filmNm ?? m.nm;
      const hit = clockMarks.find((c) => (
        Math.abs((c.filmNm ?? c.nm) - film) < 0.6 && (!m.name || c.name === m.name)
      )) || clockMarks.find((c) => c.name === m.name);
      return hit ? { ...m, iso: hit.iso, holdHours: hit.holdHours } : m;
    });
  }, [escaleMarks, officialClock]);

  const monthLabel = clockSample?.month
    ? formatMonthName(clockSample.month, lang)
    : "";
  // « Climatologie de septembre » n'est plus écrit sous l'étape : la date de
  // départ le dit déjà (revue du 19 sept.). Le mois reste sur le bandeau climato.
  const weatherLine = buildWeatherLine({
    isSuivre,
    gribReady: official.gribStatus === "ready",
  });
  const quayDays = clockSample?.holdHours > 0
    ? Math.round(clockSample.holdHours / 24)
    : 0;
  const atQuay = Boolean(clockSample?.atQuay && quayDays > 0);

  // Fiche d'escale (lot C): opened from the Expedition list (▤) in any view,
  // and by itself in Suivre when the boat is alongside — once per stop, the
  // skipper may close it. Never a chat, never blocks Play.
  const [escaleStop, setEscaleStop] = useState(null);
  const escaleSheet = useEscaleSheet(escaleStop, lang);
  const autoSheetRef = useRef(null);
  const openEscaleSheet = useCallback((stop) => {
    if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
    setEscaleStop({ name: stop.name, lat: stop.lat, lon: stop.lon });
    setSidebarOpen(true);
  }, []);
  const closeEscaleSheet = useCallback(() => {
    if (escaleStop) autoSheetRef.current = escaleStop.name;
    setEscaleStop(null);
  }, [escaleStop]);
  // Chatbot journal de bord (lot D): the client adds what only it knows —
  // the view, the film boat in Simulation, the polar, the skipper's orders.
  const chatContextRef = useRef(null);
  chatContextRef.current = {
    view: isSuivre ? "suivre" : "simulation",
    boat: !isSuivre && sample && Number.isFinite(sample.lat)
      ? { lat: sample.lat, lon: sample.lon, iso: clockSample?.iso || null }
      : null,
    polar: polarData ? { boat: polarData.boat_name || polarData.name || null, loaM: skipper.orders?.boat?.loaM, draftM: skipper.orders?.boat?.draftM, planningKn: skipper.orders?.values?.planningKn } : null,
    orders: !skipper.orders
      ? null
      : { profile: skipper.orders.profile, comfort: skipper.orders.comfort, horizonH: skipper.orders.knobs?.horizonH, values: skipper.orders.values },
    leg: hudLeg ? { from: hudLeg.fromStop, to: hudLeg.toStop, remainingNm: hudLeg.remainingNm, etaHours: hudLeg.etaHours, speedKnots: hudLeg.speedKnots } : null,
  };
  const chatContextFn = useCallback(() => chatContextRef.current, []);
  const chat = useLogbookChat({ lang, contextFn: chatContextFn });

  useEffect(() => {
    if (!isSuivre || !atQuay || !clockSample || !Number.isFinite(clockSample.lat)) return;
    let best = null;
    let bestD = Infinity;
    for (const m of legendMarks) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
      const d = haversineNm(clockSample.lat, clockSample.lon, m.lat, m.lon);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (!best || bestD > 5 || autoSheetRef.current === best.name) return;
    autoSheetRef.current = best.name;
    setEscaleStop({ name: best.name, lat: best.lat, lon: best.lon });
  }, [isSuivre, atQuay, clockSample, legendMarks]);
  const clockLine = officialClock?.vertices?.length && clockSample
    ? formatFilmClockLine({
      sailNm: isSuivre && !previewing
        ? (clockSample.sailNm ?? cast?.sailNm)
        : (cast?.sailNm ?? clockSample.sailNm),
      seaHours: clockSample.seaHours,
      iso: clockSample.iso,
      lang,
    })
    : "";
  const sidebarPlaybackNm = playback.nm;
  const sidebarHudLeg = hudLeg;
  const sidebarClockSample = clockSample;

  useEffect(() => {
    if (clockSample?.speedKnots > 0) setLiveKnots(clockSample.speedKnots);
  }, [clockSample?.speedKnots]);

  useEffect(() => {
    if (isSuivre) {
      setVoyageFlat(null);
      return;
    }
    if (vessel.voyage?.points?.length && vessel.voyage.routeRev > 0) {
      const pts = vessel.voyage.points;
      const last = pts[pts.length - 1];
      setVoyageFlat({
        points: pts,
        totalNm: last?.cumNm || 0,
        totalFilmNm: last?.filmCum || last?.cumNm || 0,
        episodes: detectAirEpisodes(pts),
      });
    }
  }, [isSuivre, vessel.voyage?.routeRev, vessel.voyage?.points]);

  const goLive = useCallback(() => {
    if (!live) return;
    setUserPreview(false);
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(Number(live.filmNm) || 0, { jump: true });
  }, [live, sceneApi]);

  useEffect(() => {
    if (isSuivre) setUserPreview(false);
  }, [isSuivre]);

  const livePrimedRef = useRef(false);
  useEffect(() => {
    if (!isSuivre) {
      livePrimedRef.current = false;
      return;
    }
    if (!routeReady || !live || userPreview) return;
    const target = Number(live.filmNm) || 0;
    if (Math.abs(playback.nm - target) > 2) {
      sceneApiRef.current?.playback.seek(target, { jump: false });
    }
    livePrimedRef.current = true;
  }, [routeReady, isSuivre, live?.filmNm, userPreview, playback.nm, sceneApi]);

  useEffect(() => {
    if (gateReady) setSceneRevealed(true);
  }, [gateReady]);
  useEffect(() => {
    if (!routeReady) setSceneRevealed(false);
  }, [routeReady]);

  // The Simulation keeps its playhead across a visit to Suivre: coming back
  // resumes where the film was, not at Saint-Maur (revue du 19 sept.).
  // Captured when leaving Simulation (selectView), read when coming back.
  const simNmRef = useRef(0);

  const simPrimedRef = useRef(false);
  useEffect(() => {
    if (!isSimulation) {
      simPrimedRef.current = false;
      return;
    }
    if (!routeReady || simPrimedRef.current) return;
    simPrimedRef.current = true;
    voyage.setStartAt("saint-maur");
    sceneApiRef.current?.playback.setProfile("normal");
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(simNmRef.current || 0, { jump: true });
  }, [isSimulation, routeReady, voyage.setStartAt, sceneApi]);

  // Playing the film follows the boat; a manual drag lets go (onManualNavigation).
  useEffect(() => {
    if (isSimulation && playback.playing) setCameraFollow(true);
  }, [isSimulation, playback.playing]);

  const canRecompute = Boolean(
    isSimulation
    && cast?.vehicle === "main"
    && vessel.voyage?.voyageId,
  );

  const alongPack = useIciAlong({
    enabled: Boolean(cast && routeReady),
    flat: flatRoute,
    fromNm: chapterAtNm(escaleMarks, cast?.sailNm ?? playback.nm)?.from?.nm,
    toNm: destMark?.nm,
    boatNm: cast?.sailNm ?? clockSample?.sailNm ?? playback.nm,
    boatLat: sample?.lat,
    boatLon: sample?.lon,
    mode: isSuivre ? "suivre" : "simulation",
    month: climoMonth,
    orders: skipper.orders,
    // The Berry route has canonical pearls warmed on the server; a drawn route samples itself.
    canonical: routeKind === "berry",
  });

  const iciPack = useIciDossier({
    enabled: Boolean(cast),
    cast,
    snappedPosition: legContext?.snappedPosition,
    polarMeta: polarData,
    jambe,
    lang,
    month: climoMonth,
    destLat: destMark?.lat,
    destLon: destMark?.lon,
    climatology: atlas.boatPoint
      ? {
        kind: "climatology",
        source: "atlas",
        month: climoMonth,
        period: atlas.boatPoint.period,
        doi: atlas.boatPoint.doi,
        point: atlas.boatPoint,
        crossings: atlas.boatPoint.crossings || atlas.boatPoint.cyclone?.crossings_if_leg,
      }
      : null,
    mode: isSuivre ? "suivre" : "simulation",
    cinema: cinemaMode,
    playbackProfile: playback.profile,
    cumNm: cast?.sailNm ?? clockSample?.sailNm ?? playback.nm,
    filmCum: isSuivre && live && !previewing ? (Number(live.filmNm) || playback.nm) : playback.nm,
    clockMin: Number.isFinite(clockSample?.seaHours) ? clockSample.seaHours * 60 : null,
    rainMm: isSuivre ? official.live?.rainMm ?? null : null,
    rain3hMm: isSuivre ? sumRainHours(official.grib?.samples, official.live?.iso, 3) : null,
    gribWindKnots: isSuivre ? official.live?.windKnots ?? null : null,
    gribDirFromDeg: isSuivre ? official.live?.dirFromDeg ?? null : null,
    gribHs: isSuivre ? official.live?.hs ?? null : null,
    gribModel: isSuivre ? official.live?.model ?? official.gribModel ?? null : null,
    gribStatus: isSuivre ? official.gribStatus : null,
    along: alongPack.index,
    nearestBag: alongPack.nearestBag,
    skipperClickId,
    orders: skipper.orders,
  });

  // Carte du moment : NOW (sécurité / décision) + FREE (information), nourries
  // par le registre jugé et le sac. Jamais un appel réseau de son côté.
  const momentFilmCum = isSuivre && live && !previewing ? (Number(live.filmNm) || playback.nm) : playback.nm;
  const momentLegId = hudLeg ? `${hudLeg.fromStop || ""}→${hudLeg.toStop || ""}` : null;
  // What the escale card says when the boat leaves a stopover.
  const momentLeg = useMemo(() => {
    if (!hudLeg?.fromStop) return null;
    const from = legendMarks.find((m) => m.name === hudLeg.fromStop);
    const to = hudLeg.toStop ? legendMarks.find((m) => m.name === hudLeg.toStop) : null;
    return {
      fromStop: hudLeg.fromStop,
      toStop: hudLeg.toStop || null,
      holdDays: from?.holdHours > 0 ? Math.round(from.holdHours / 24) : 0,
      legNm: from && to ? Math.max(0, (Number(to.nm) || 0) - (Number(from.nm) || 0)) : null,
      etaLabel: to?.iso ? dayMonth(to.iso, lang) : null,
      lat: from?.lat,
      lon: from?.lon,
    };
  }, [hudLeg?.fromStop, hudLeg?.toStop, legendMarks, lang]);
  const moments = useMomentCards({
    enabled: sceneReady && !drawingMode,
    events: iciPack.events,
    bag: iciPack.dossier,
    filmCum: momentFilmCum,
    playing: playback.playing,
    mode: isSuivre ? "suivre" : "simulation",
    lang,
    legId: momentLegId,
    leg: momentLeg,
  });

  // Stop auto : le film s'arrête sur chaque nouvelle carte (NOW, et FREE hors
  // boucle) pour laisser le temps de lire ; Lecture repart.
  const lastCardKeysRef = useRef({ now: null, free: null });
  useEffect(() => {
    const nowKey = moments.now?.key || null;
    const freeKey = moments.free?.key || null;
    const prevKeys = lastCardKeysRef.current;
    const newNow = Boolean(nowKey && nowKey !== prevKeys.now);
    const newFree = Boolean(freeKey && freeKey !== prevKeys.free && !moments.free?.loop);
    lastCardKeysRef.current = { now: nowKey, free: freeKey };
    if (!isSimulation || !stopAuto || !playback.playing) return;
    if (newNow || newFree) sceneApiRef.current?.playback.pause();
  }, [moments.now?.key, moments.free?.key, moments.free?.loop, isSimulation, stopAuto, playback.playing]);

  // Le récit de la traversée (Suivre) : de Saint-Maur à la position du jour,
  // d'après l'horloge officielle et le journal. Zéro LLM.
  const storyParagraphs = useMemo(() => {
    if (!isSuivre || !officialClock) return [];
    return expeditionStory({
      clock: officialClock,
      marks: legendMarks,
      live,
      leg: hudLeg,
      journal: officialJournal.journal,
      now: live?.iso || Date.now(),
      lang,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuivre, officialClock, legendMarks, live?.iso, live?.status, live?.atQuay, live?.windKnots, hudLeg?.toStop, hudLeg?.fromStop, Math.round(hudLeg?.remainingNm || 0), officialJournal.journal, lang]);
  const speechText = isSuivre
    ? [...storyParagraphs, iciPack.briefing].filter(Boolean)
    : (iciPack.briefing || null);

  const playheadNmRef = useRef(0);
  playheadNmRef.current = playback.nm;

  const handleSimNext = useCallback(() => {
    if (!isSimulation) return;
    const focusBoat = shouldFocusSimulationJump({
      isSimulation,
      playing: playback.playing,
    });
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(nextEscaleNm(escaleMarks, playheadNmRef.current), { jump: true });
    if (focusBoat) setCameraFocusToken((token) => token + 1);
  }, [playback.playing, escaleMarks, isSimulation, sceneApi]);

  const handleSimPrev = useCallback(() => {
    if (!isSimulation) return;
    const focusBoat = shouldFocusSimulationJump({
      isSimulation,
      playing: playback.playing,
    });
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(prevEscaleNm(escaleMarks, playheadNmRef.current), { jump: true });
    if (focusBoat) setCameraFocusToken((token) => token + 1);
  }, [playback.playing, escaleMarks, isSimulation, sceneApi]);

  const handleCatamaranDrag = useCallback((pos) => {
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(sailNmToFilmNm(flatRoute, nearestNm(flatRoute, pos.lat, pos.lon)));
  }, [flatRoute, sceneApi]);

  const recaptureBoat = useCallback(() => {
    setCameraFollow(true);
    setCinemaRecapture((n) => n + 1);
  }, []);

  /** BI toggle setter for a briefing entity's layer (null when the layer has no toggle). */
  const LAYER_SETTER = {
    poe: "setShowBiPoe",
    amp: "setShowBiAmp",
    projects: "setShowBiProjects",
    marinas: "setShowBiMarinas",
    capitaineries: "setShowBiCapitaineries",
    wpi: "setShowPorts",
    aton: "setShowBalisage",
    sextant: "setShowSextant",
    csr: "setShowCsr",
    argo: "setShowArgo",
    odatis: "setShowOdatis",
    edmed: "setShowEdmed",
  };

  /**
   * Briefing link "voir sur la carte": switch the place's layer on, then pin
   * it and fit the map on the boat AND the place. Never a GET /ici, never a chat.
   */
  const handleBriefingFocus = useCallback((entity) => {
    if (!entity || !Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) return;
    const layer = layerForEntity(entity);
    const setter = layer ? maritimeLayers[LAYER_SETTER[layer]] : null;
    if (typeof setter === "function") setter(true);
    const at = iciPack.dossier?.at;
    const boat = at && Number.isFinite(at.lat) && Number.isFinite(at.lon) ? { lat: at.lat, lon: at.lon } : null;
    sceneApiRef.current?.briefing?.focus(entity, boat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maritimeLayers, iciPack.dossier]);

  const leaveCinema = useCallback(() => {
    setSidebarOpen(cinemaSavedRef.current.sidebar);
    setToolsOpen(cinemaSavedRef.current.tools);
    setCinemaMode(false);
    setHideFilmBar(false);
    // The camera keeps following the boat: leaving Cinema is not a manual drag.
  }, []);

  const toggleCinema = useCallback(() => {
    if (!cinemaMode) {
      cinemaSavedRef.current = { sidebar: sidebarOpen, tools: toolsOpen };
      setSidebarOpen(false);
      setToolsOpen(false);
      setCinemaMode(true);
      recaptureBoat();
      return;
    }
    if (!cameraFollow) {
      recaptureBoat();
      return;
    }
    leaveCinema();
  }, [cinemaMode, cameraFollow, sidebarOpen, toolsOpen, recaptureBoat, leaveCinema]);

  const selectView = useCallback((next) => {
    if (next === VIEW_SUIVRE && view === VIEW_SIMULATION) simNmRef.current = playheadNmRef.current;
    setView(next);
    if (next === VIEW_SUIVRE) {
      voyage.setStartAt(DEFAULT_START_AT);
      sceneApiRef.current?.playback.pause();
      setUserPreview(false);
      if (!cinemaMode) {
        cinemaSavedRef.current = { sidebar: sidebarOpen, tools: toolsOpen };
      }
      setSidebarOpen(false);
      setToolsOpen(false);
      setCinemaMode(true);
      recaptureBoat();
    } else {
      voyage.setStartAt("saint-maur");
      sceneApiRef.current?.playback.setProfile("normal");
      sceneApiRef.current?.playback.pause();
      sceneApiRef.current?.playback.seek(simNmRef.current || 0, { jump: true });
    }
  }, [
    cinemaMode,
    recaptureBoat,
    sceneApi,
    sidebarOpen,
    toolsOpen,
    view,
    voyage.setStartAt,
  ]);

  useEffect(() => {
    if (isSuivre) voyage.setStartAt(DEFAULT_START_AT);
  }, [isSuivre, voyage.setStartAt]);

  useEffect(() => {
    if (isSuivre) sceneApiRef.current?.playback.setProfile("real");
  }, [isSuivre, sceneApi]);

  // A new route (drawn or Berry again) starts its film at 0 — a mode switch does not.
  useEffect(() => {
    if (!isSimulation) return;
    simNmRef.current = 0;
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customRoute, sceneApi]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.target?.closest?.("button") && e.code === "Space") return;
      if (isSimulation && e.code === "Space") {
        e.preventDefault();
        sceneApiRef.current?.playback.toggle();
      } else if (isSimulation && e.code === "ArrowRight") {
        e.preventDefault();
        handleSimNext();
      } else if (isSimulation && e.code === "ArrowLeft") {
        e.preventDefault();
        handleSimPrev();
      } else if (isCinemaKey(e)) {
        e.preventDefault();
        toggleCinema();
      } else if (isSuivre && e.code === "KeyL") {
        e.preventDefault();
        goLive();
      } else if (e.code === "Escape" && cinemaMode && !drawingMode) {
        e.preventDefault();
        leaveCinema();
      } else if (isSimulation && e.code === "Digit1") {
        sceneApiRef.current?.playback.setProfile("real");
      } else if (isSimulation && e.code === "Digit2") {
        sceneApiRef.current?.playback.setProfile("read");
      } else if (isSimulation && e.code === "Digit3") {
        sceneApiRef.current?.playback.setProfile("normal");
      } else if (isSimulation && e.code === "Digit4") {
        sceneApiRef.current?.playback.setProfile("fast");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cinemaMode, drawingMode, goLive, handleSimNext, handleSimPrev, isSimulation, isSuivre, leaveCinema, sceneApi, toggleCinema]);

  const applyBerryBriefing = useCallback(() => {
    setExpeditionPlan(getCachedPlan(lang) || normalizeExpeditionPlan({ executive_briefing: t("berryLocalBriefing") }));
    setBriefingLoading(false);
  }, [lang, t]);

  const handleRouteSwitchToBerry = useCallback(() => {
    customFetchIdRef.current += 1;
    routeKindRef.current = "berry";
    setCustomRoute(null);
    setRouteKind("berry");
    setVoyageFlat(null);
    applyBerryBriefing();
  }, [applyBerryBriefing]);

  const fetchCustomPlan = useCallback((geojson) => {
    const applyFallback = () => setExpeditionPlan(buildLocalCustomBriefing(geojson, lang));
    setExpeditionPlan(null);
    const wps = waypointsFromCollection(geojson);
    const hasLine = (geojson?.features || []).some((f) => f?.geometry?.type === "LineString" && f.geometry.coordinates?.length >= 2);
    if (wps.length < 2 && !hasLine) { setBriefingLoading(false); applyFallback(); return; }
    const requestId = ++customFetchIdRef.current;
    setBriefingLoading(true);
    const finish = (plan) => {
      if (customFetchIdRef.current !== requestId || routeKindRef.current !== "custom") return;
      setExpeditionPlan(normalizeExpeditionPlan(plan));
      setBriefingLoading(false);
    };
    if (!ORCHESTRATOR_URL) { finish(buildLocalCustomBriefing(geojson, lang)); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(`${ORCHESTRATOR_URL}/api/v1/expedition/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: lang, waypoints: wps }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`plan ${r.status}`))))
      .then((data) => finish(normalizeExpeditionPlan(data?.expedition_plan) || buildLocalCustomBriefing(geojson, lang)))
      .catch(() => finish(buildLocalCustomBriefing(geojson, lang)))
      .finally(() => clearTimeout(timer));
  }, [lang]);

  const handleCustomRoute = useCallback((geojson) => {
    berryFetchIdRef.current += 1;
    routeKindRef.current = "custom";
    setView(VIEW_SIMULATION);
    setCustomRoute(geojson);
    setRouteKind("custom");
    setVoyageFlat(null);
    setBriefingLoading(true);
    fetchCustomPlan(geojson);
  }, [fetchCustomPlan]);

  const _resetDrawState = () => {
    setDrawnPoints([]);
    setDrawnSegments([]);
    setCanRedo(false);
    drawnPointsRef.current = [];
    drawnSegmentsRef.current = [];
    undonePointsRef.current = [];
    undoneSegmentsRef.current = [];
    fetchIdRef.current = 0;
  };

  const handleDrawStart = () => {
    const mapView = sceneApiRef.current?.getView();
    drawRestoreRef.current = {
      view,
      center: mapView?.center || null,
      zoom: mapView?.zoom ?? null,
    };
    sceneApiRef.current?.playback.pause();
    if (cinemaMode) {
      setSidebarOpen(cinemaSavedRef.current.sidebar);
      setToolsOpen(cinemaSavedRef.current.tools);
      setHideFilmBar(false);
    }
    setCinemaMode(false);
    setCameraFollow(false);
    setDrawingMode(true);
    _resetDrawState();
    berryFetchIdRef.current += 1;
    setExpeditionPlan(null);
    setBriefingLoading(false);
  };

  const handleDrawCancel = () => {
    setDrawingMode(false);
    _resetDrawState();
    closeSatellite();
    const prev = drawRestoreRef.current;
    if (prev.view && prev.view !== view) setView(prev.view);
    const mapView = sceneApiRef.current?.getView();
    if (mapView && prev.center) {
      sceneApiRef.current?.setView(prev.center, prev.zoom ?? mapView.zoom, { animate: false });
    }
  };

  const handleDrawFinish = () => {
    const lineFeatures = drawnSegmentsRef.current.filter((s) => s.coords?.length > 0).map((s) => ({
      type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: s.coords },
    }));
    const pointFeatures = drawnPointsRef.current.map((p, i) => ({
      type: "Feature",
      properties: { name: p.name || `Point ${i + 1}`, flags: p.flags || [], naviguide_type: "drawn_waypoint" },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    }));
    setDrawingMode(false);
    return { type: "FeatureCollection", features: [...lineFeatures, ...pointFeatures] };
  };

  const handleDrawContinue = () => {
    const mapView = sceneApiRef.current?.getView();
    drawRestoreRef.current = {
      view,
      center: mapView?.center || null,
      zoom: mapView?.zoom ?? null,
    };
    sceneApiRef.current?.playback.pause();
    setCinemaMode(false);
    setCameraFollow(false);
    setDrawingMode(true);
    setExpeditionPlan(null);
    setBriefingLoading(false);
  };

  const handleCustomDelete = () => {
    customFetchIdRef.current += 1;
    routeKindRef.current = "berry";
    setCustomRoute(null);
    setRouteKind("berry");
    setVoyageFlat(null);
    _resetDrawState();
    applyBerryBriefing();
  };

  const fetchDrawnSegment = async (from, to) => {
    const myFetchId = ++fetchIdRef.current;
    setDrawingLoading(true);
    try {
      const params = new URLSearchParams({ start_lat: from.lat, start_lon: from.lon, end_lat: to.lat, end_lon: to.lon });
      const res = await fetch(`${API_URL}/route?${params}`);
      const data = await res.json();
      let coords = coordsFromRoutePayload(data);
      let failed = false;
      if (!coords.length) {
        coords = [[from.lon, from.lat], [to.lon, to.lat]];
        failed = true;
      }
      if (fetchIdRef.current === myFetchId) {
        const updated = [...drawnSegmentsRef.current, { coords, failed }];
        drawnSegmentsRef.current = updated;
        setDrawnSegments([...updated]);
      }
    } catch {
      if (fetchIdRef.current === myFetchId) {
        const updated = [...drawnSegmentsRef.current, { coords: [[from.lon, from.lat], [to.lon, to.lat]], failed: true }];
        drawnSegmentsRef.current = updated;
        setDrawnSegments([...updated]);
      }
    } finally {
      if (fetchIdRef.current === myFetchId) setDrawingLoading(false);
    }
  };

  const handleDrawingClick = (lat, lon) => {
    const newPoint = { lat, lon };
    const updated = [...drawnPointsRef.current, newPoint];
    drawnPointsRef.current = updated;
    undonePointsRef.current = [];
    undoneSegmentsRef.current = [];
    setCanRedo(false);
    setDrawnPoints([...updated]);
    if (updated.length >= 2) fetchDrawnSegment(updated[updated.length - 2], newPoint);
  };

  const handleDrawUndo = () => {
    if (!drawnPointsRef.current.length) return;
    fetchIdRef.current += 1;
    undonePointsRef.current = [...undonePointsRef.current, drawnPointsRef.current.at(-1)];
    drawnPointsRef.current = drawnPointsRef.current.slice(0, -1);
    if (drawnSegmentsRef.current.length) {
      undoneSegmentsRef.current = [...undoneSegmentsRef.current, drawnSegmentsRef.current.at(-1)];
      drawnSegmentsRef.current = drawnSegmentsRef.current.slice(0, -1);
    }
    setDrawnPoints([...drawnPointsRef.current]);
    setDrawnSegments([...drawnSegmentsRef.current]);
    setDrawingLoading(false);
    setCanRedo(true);
  };

  const handleDrawRedo = () => {
    if (!undonePointsRef.current.length) return;
    const restoredPoint = undonePointsRef.current.at(-1);
    undonePointsRef.current = undonePointsRef.current.slice(0, -1);
    drawnPointsRef.current = [...drawnPointsRef.current, restoredPoint];
    if (undoneSegmentsRef.current.length) {
      drawnSegmentsRef.current = [...drawnSegmentsRef.current, undoneSegmentsRef.current.at(-1)];
      undoneSegmentsRef.current = undoneSegmentsRef.current.slice(0, -1);
    }
    setDrawnPoints([...drawnPointsRef.current]);
    setDrawnSegments([...drawnSegmentsRef.current]);
    setCanRedo(undonePointsRef.current.length > 0);
  };

  useEffect(() => {
    const onEscDraw = (e) => {
      if (e.code !== "Escape" || !drawingMode) return;
      if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      handleDrawCancel();
    };
    window.addEventListener("keydown", onEscDraw);
    return () => window.removeEventListener("keydown", onEscDraw);
  }, [drawingMode]);

  useEffect(() => {
    if (routeKind !== "berry" || drawingMode) return;
    setExpeditionPlan(getCachedPlan(lang) || normalizeExpeditionPlan({ executive_briefing: t("berryLocalBriefing") }));
    if (!ORCHESTRATOR_URL) return;
    const requestId = ++berryFetchIdRef.current;
    fetch(`${ORCHESTRATOR_URL}/api/v1/expedition/plan/berry-mappemonde`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: lang,
        waypoints: ITINERARY_POINTS.map((p) => ({
          name: p.name, lat: p.lat, lon: p.lon, type: p.flag ? "escale_obligatoire" : "point_intermediaire",
        })),
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (routeKindRef.current !== "berry" || berryFetchIdRef.current !== requestId) return;
        const plan = normalizeExpeditionPlan(data?.expedition_plan);
        if (plan) {
          setExpeditionPlan(plan);
          setCachedPlan(lang, plan);
        }
      })
      .catch(() => {});
  }, [lang, routeKind, drawingMode, t]);

  useEffect(() => {
    if (routeKind !== "custom" || drawingMode || !customRoute) return;
    fetchCustomPlan(customRoute);
  }, [lang]);

  useEffect(() => { setPoints(ITINERARY_POINTS); }, []);

  useEffect(() => {
    if (!points.length) return undefined;
    const legs = buildBerryLegs(points);
    let cancelled = false;
    (async () => {
      setLoading(true);
      setOfficialFallback(false);
      try {
        const official = await loadOfficialBerryRoute();
        if (cancelled) return;
        setSegments(official.segments);
        setOfficialFallback(false);
        setLoading(false);
        setSegProgress({ done: official.segments.length, total: official.segments.length });
        return;
      } catch { /* searoute si le geojson officiel manque */ }
      setSegProgress({ done: 0, total: legs.length });
      const accumulated = [];
      const fetchLeg = async (leg) => {
        if (isNonMaritimeLeg(leg.from.name, leg.to.name)) {
          return { ...leg, coords: [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]], nonMaritime: true };
        }
        try {
          const params = new URLSearchParams({
            start_lat: leg.from.lat, start_lon: leg.from.lon, end_lat: leg.to.lat, end_lon: leg.to.lon, check_wind: false,
          });
          const res = await fetch(`${API_URL}/route?${params}`);
          if (!res.ok) return { ...leg, coords: [], error: `HTTP ${res.status}` };
          const data = await res.json();
          const coords = orientCoords(coordsFromRoutePayload(data), leg.from, leg.to);
          if (!coords.length) return { ...leg, coords: [], error: "empty route" };
          return { ...leg, coords, nonMaritime: false };
        } catch (e) {
          return { ...leg, coords: [], error: e.message };
        }
      };
      for (let i = 0; i < legs.length && !cancelled; i += SEGMENT_BATCH_SIZE) {
        const batch = await Promise.all(legs.slice(i, i + SEGMENT_BATCH_SIZE).map(fetchLeg));
        accumulated.push(...batch);
        if (!cancelled) {
          setSegments(accumulated.filter((r) => r.coords?.length));
          setSegProgress({ done: Math.min(i + SEGMENT_BATCH_SIZE, legs.length), total: legs.length });
          if (i === 0) setLoading(false);
        }
      }
      if (!cancelled) {
        setOfficialFallback(accumulated.every((r) => r.nonMaritime || !r.coords?.length || r.error));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [points]);

  const fetchSatellite = useCallback(async (lat, lon, extra = {}) => {
    const previous = satelliteRequestRef.current;
    previous.controller?.abort();
    const controller = new AbortController();
    const id = previous.id + 1;
    satelliteRequestRef.current = { id, controller };
    setSatelliteLoading(true);
    setSatelliteTab("wind");
    setSelectedSatellite({ lat, lon, ...extra });
    try {
      const data = await fetchWeatherComposite(lat, lon, {
        signal: controller.signal,
        api: API_URL,
      });
      if (satelliteRequestRef.current.id !== id) return;
      setSelectedSatellite((prev) => (prev ? { ...prev, ...data } : prev));
      setSatelliteLoading(satelliteBusy(data));
    } catch (err) {
      if (controller.signal.aborted || satelliteRequestRef.current.id !== id) return;
      setSelectedSatellite((prev) => (prev ? { ...prev, error: true } : prev));
      setSatelliteLoading(false);
    } finally {
      if (satelliteRequestRef.current.id === id) {
        satelliteRequestRef.current.controller = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedSatellite || selectedSatellite.error) return undefined;
    const lat = selectedSatellite.lat;
    const lon = selectedSatellite.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    const requestId = satelliteRequestRef.current.id;
    const delay = weatherPollMs(selectedSatellite);
    const timer = setInterval(() => {
      const controller = new AbortController();
      satelliteRequestRef.current.controller?.abort();
      satelliteRequestRef.current.controller = controller;
      fetchWeatherComposite(lat, lon, { signal: controller.signal, api: API_URL })
        .then((data) => {
          if (satelliteRequestRef.current.id !== requestId) return;
          setSelectedSatellite((prev) => (
            prev && prev.lat === lat && prev.lon === lon ? { ...prev, ...data } : prev
          ));
          setSatelliteLoading(satelliteBusy(data));
        })
        .catch(() => {});
    }, delay);
    return () => clearInterval(timer);
  }, [selectedSatellite?.lat, selectedSatellite?.lon, selectedSatellite?.status, selectedSatellite?.refreshing, selectedSatellite?.error]);

  useEffect(() => cancelSatelliteRequest, [cancelSatelliteRequest]);

  const handleMapRouteClick = useCallback((position) => {
    fetchSatellite(position.lat, position.lon);
  }, [fetchSatellite]);

  const handleSaveDrawPointMeta = () => {
    if (selectedSatellite?.drawPointIndex != null) {
      const idx = selectedSatellite.drawPointIndex;
      const updated = [...drawnPointsRef.current];
      updated[idx] = { ...updated[idx], name: pointInfoName.trim() || undefined, flags: pointInfoFlags.filter(Boolean) };
      drawnPointsRef.current = updated;
      setDrawnPoints([...updated]);
    }
    setSelectedSatellite(null);
  };

  const drawingMessage = drawnPoints.length === 0 ? t("drawStart") : drawnPoints.length === 1 ? t("drawFirstStop") : t("drawNextStop");
  const statsSegs = useMemo(
    () => (customRoute ? featuresToSegments(customRoute) : segments),
    [customRoute, segments],
  );
  const stats = useMemo(() => summarizeRoute(statsSegs), [statsSegs]);
  const statsPoints = useMemo(
    () => (customRoute
      ? (customRoute.features || []).filter((f) => f.geometry?.type === "Point").map((f) => ({
        name: f.properties?.name || "", lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], flag: "",
      }))
      : points),
    [customRoute, points],
  );
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const toggleTools = useCallback(() => setToolsOpen((open) => !open), []);
  const handleSidebarSeek = useCallback((nm) => {
    sceneApiRef.current?.playback.pause();
    sceneApiRef.current?.playback.seek(nm, { jump: true });
  }, [sceneApi]);
  const handleRecompute = useCallback(
    () => vessel.recompute(clockSample?.iso),
    [vessel.recompute, clockSample?.iso],
  );
  const mapScene = useMemo(() => ({
    isLightMode,
    view,
    isSimulation,
    isSuivre,
    routeReady,
    sceneReady,
    segments,
    points,
    customRoute,
    drawingMode,
    drawnPoints,
    drawnSegments,
    flat: flatRoute,
    marks: escaleMarks,
    stops: activeStops,
    boatKnots,
    stopAuto: isSimulation && stopAuto,
    live,
    previewing,
    draft: vessel.draft,
    grib: official.grib,
    gribStatus: official.gribStatus,
    clockSample,
    climoMonth,
    t,
    cameraFollow,
    cinemaRecapture,
    cameraFocusToken: isSimulation ? cameraFocusToken : 0,
    remainingNm: hudLeg?.remainingNm ?? playback.sailTotalNm,
    recetteMap: recetteMapView(),
  }), [
    isLightMode,
    view,
    isSimulation,
    isSuivre,
    routeReady,
    sceneReady,
    segments,
    points,
    customRoute,
    drawingMode,
    drawnPoints,
    drawnSegments,
    flatRoute,
    escaleMarks,
    activeStops,
    boatKnots,
    stopAuto,
    live,
    previewing,
    vessel.draft,
    official.grib,
    official.gribStatus,
    clockSample,
    climoMonth,
    t,
    cameraFollow,
    cinemaRecapture,
    cameraFocusToken,
    hudLeg?.remainingNm,
    playback.sailTotalNm,
  ]);

  const enablePendingRestricted = (kind) => {
    if (kind === "balisage") maritimeLayers.setShowBalisage(true);
    if (kind === "bathymetry") maritimeLayers.setShowBathymetry(true);
    if (kind === "fonds") maritimeLayers.setShowFonds(true);
    if (kind === "cables") maritimeLayers.setShowCables(true);
  };

  const rootInsetVars = mapInsetVars({
    sidebarOpen,
    toolsOpen,
    filmBarVisible: !(cinemaMode && hideFilmBar),
    filmBarControls: isSimulation,
  });

  return (
    <div style={{ height: "100vh", width: "100vw", position: "relative", ...rootInsetVars }} className={isLightMode ? "light-mode" : ""}>
      <MapScene
        scene={mapScene}
        gateRef={gateRef}
        onReady={handleSceneReady}
        onPlayback={handleScenePlayback}
        onLayerState={handleLayerState}
        onClimatologyState={handleClimatologyState}
        onFeature={onFeature}
        onCameraPlaced={setCameraPlaced}
        onManualNavigation={() => setCameraFollow(false)}
        onDrawingClick={handleDrawingClick}
        onRouteClick={handleMapRouteClick}
        onBoatDrag={handleCatamaranDrag}
        onCoordinatesCopied={handleCoordinatesCopied}
        onWaypointHover={setHoveredPoint}
        onDrawingWaypointClick={handleDrawingWaypointClick}
      />

      <NotForNavModal
        open={notForNavOpen}
        onCancel={() => { pendingLayerRef.current = null; setNotForNavOpen(false); }}
        onAccept={() => {
          writeNotForNavAccepted();
          gateRef.current.allowed = true;
          setNotForNavOk(true);
          setNotForNavOpen(false);
          enablePendingRestricted(pendingLayerRef.current);
          pendingLayerRef.current = null;
        }}
      />
      <Sidebar
        plan={expeditionPlan}
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onCustomRoute={handleCustomRoute}
        onRouteSwitchToBerry={handleRouteSwitchToBerry}
        isDrawing={drawingMode}
        onDrawStart={handleDrawStart}
        onDrawContinue={handleDrawContinue}
        onDrawFinish={handleDrawFinish}
        onDrawCancel={handleDrawCancel}
        onCustomDelete={handleCustomDelete}
        canContinueDraw={drawnPoints.length > 0}
        canFinishDraw={drawnPoints.length >= 2 && !drawingLoading}
        isCockpit={false}
        polarData={polarData}
        briefingLoading={iciPack.loading || briefingLoading}
        officialFallback={officialFallback}
        iciBriefing={iciPack.briefing}
        iciBriefingSegments={iciPack.briefingSegments}
        onBriefingFocus={handleBriefingFocus}
        journal={officialJournal.journal}
        journalLoading={officialJournal.loading}
        journalError={officialJournal.error}
        story={storyParagraphs}
        skipperNotice={skipper.notice}
        view={view}
        legContext={sidebarHudLeg}
        clockSample={sidebarClockSample}
        atQuay={atQuay}
        quayDays={quayDays}
        previewing={previewing}
        forecastStatus={isSuivre && official.gribStatus === "ready" ? "ready" : null}
        onRecompute={handleRecompute}
        canRecompute={canRecompute}
        recomputeBusy={vessel.busy}
        onGoLive={goLive}
        momentNow={sceneReady ? moments.now : null}
        momentNowLeft={moments.nowLeft}
        onMomentDismiss={moments.dismiss}
        momentFree={sceneReady ? moments.free : null}
        momentFreeLeft={moments.freeLeft}
        onMomentNext={moments.next}
        escaleStop={escaleStop}
        escaleSheet={escaleSheet}
        onEscaleClose={closeEscaleSheet}
        chat={chat}
        onChatAsk={chat.ask}
      />

      <ToolsSidebar
        segments={statsSegs}
        points={statsPoints}
        open={toolsOpen}
        onToggle={toggleTools}
        isLightMode={isLightMode}
        onLightModeChange={setIsLightMode}
        polarData={polarData}
        onPolarDataLoaded={setPolarData}
        routeDistanceNm={stats.nm}
        routeSegmentCount={stats.segments}
        maritimeLayers={{
          ...maritimeLayers,
          loadingClimoWind: climoLayer.loading && maritimeLayers.showClimoWind,
          loadingClimoWave: climoLayer.loading && maritimeLayers.showClimoWave,
          loadingClimoCurrent: climoLayer.loading && maritimeLayers.showClimoCurrent,
          loadingClimoCyclones: climoLayer.loading && maritimeLayers.showClimoCyclones,
          errorClimatology: climoLayer.error,
        }}
        escaleMarks={legendMarks}
        filmNm={sidebarPlaybackNm}
        onSeekEscale={handleSidebarSeek}
        onEscaleSheet={openEscaleSheet}
        showDeparture={isSimulation}
        departureT0={voyage.t0}
        onDepartureT0={voyage.setT0}
        skipperOrders={skipper.orders}
        skipperProfile={skipper.profile}
        onSkipperProfile={skipper.setProfile}
        onSkipperComfort={skipper.setComfort}
        onSkipperHorizon={skipper.setHorizon}
        onSkipperExpert={skipper.setExpert}
        onSkipperBoat={skipper.setBoat}
        onSkipperReset={skipper.reset}
        skipperSuggest={skipper.suggest}
        onSkipperSuggestAccept={skipper.acceptSuggest}
        onSkipperSuggestDismiss={skipper.dismissSuggest}
      />

      {!sceneReady && !drawingMode && (
        <div data-testid="scene-load-mask" className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center z-[1500] pointer-events-none">
          <div className="w-10 h-10 border-4 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
          <div className="mt-4 text-white/90 text-sm font-medium">{t(sceneMaskKey({ routeReady }))}</div>
        </div>
      )}

      {!sceneReady && !drawingMode && segProgress.done < segProgress.total && (
        <div className="absolute bottom-20 right-5 z-20 flex items-center gap-2 bg-slate-900/90 text-white text-xs font-medium px-3 py-2 rounded-full shadow-lg pointer-events-none">
          <div className="w-3.5 h-3.5 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
          <span>{t("routesProgress", { done: segProgress.done, total: segProgress.total })}</span>
        </div>
      )}

      {drawingMode && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[2100] pointer-events-none">
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-2 bg-slate-900/95 border border-green-500/50 text-white text-sm font-semibold px-4 py-2.5 rounded-full shadow-2xl">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span>{drawingMessage}</span>
              {drawingLoading && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              <div className="flex gap-1 ml-1 pointer-events-auto">
                <button type="button" onClick={handleDrawUndo} disabled={!drawnPoints.length} className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 disabled:opacity-30" title={t("undoLastPoint")}><Undo2 size={13} /></button>
                <button type="button" onClick={handleDrawRedo} disabled={!canRedo} className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 disabled:opacity-30" title={t("redo")}><Redo2 size={13} /></button>
                <button type="button" onClick={handleDrawCancel} className="h-7 px-2 rounded-full bg-white/10 text-[11px] font-semibold" title={t("cancel")}>{t("cancel")}</button>
              </div>
            </div>
            {drawnSegments.some((s) => s.failed) && (
              <div className="bg-orange-950/90 border border-orange-400/50 text-orange-100 text-[11px] font-medium px-3 py-1 rounded-full">
                {t("searouteDrawFailed")}
              </div>
            )}
          </div>
        </div>
      )}

      {clipboardToast && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 z-30 bg-slate-900/95 text-white text-xs px-4 py-2 rounded-full">
          📋 {clipboardToast} {t("copied")}
        </div>
      )}

      {hoveredPoint && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 bg-slate-900/90 text-white text-xs px-3 py-1.5 rounded-full pointer-events-none">
          {hoveredPoint.name}
        </div>
      )}

      {climoAnyOn && (
        <div
          data-testid="climatology-banner"
          className="naviguide-climo-banner absolute left-1/2 -translate-x-1/2 z-20 bg-sky-950/90 border border-sky-400/40 text-sky-100 text-xs px-4 py-2 rounded-full bottom-48 pointer-events-none"
        >
          {t("climatologyOn", { month: monthLabel || String(climoMonth), maps: climoMapsLabel })}
          {climoLayer.counts && (
            <span className="ml-2 opacity-80" data-testid="climatology-overlay-ready">
              {[
                maritimeLayers.showClimoWind && `roses ${climoLayer.counts.wind || 0}`,
                maritimeLayers.showClimoWave && `P50 ${climoLayer.counts.waveP50 || 0}`,
                maritimeLayers.showClimoWave && `P90 ${climoLayer.counts.waveP90 || 0}`,
                maritimeLayers.showClimoWave && climoLayer.counts.waveMean ? `Hs mean ${climoLayer.counts.waveMean}` : null,
                maritimeLayers.showClimoCurrent && `courant ${climoLayer.counts.current || 0}`,
                maritimeLayers.showClimoCyclones && `IBTrACS ${climoLayer.counts.cyclones || 0}`,
              ].filter(Boolean).join(" · ")}
            </span>
          )}
          {climoLayer.error === "atlas_empty" && atlas.alive === false && (
            <span className="ml-2 text-amber-200">{t("climatologyAtlasDown")}</span>
          )}
        </div>
      )}

      <SimulationFilmBar
        fromName={hudLeg?.fromStop}
        toName={hudLeg?.toStop}
        finished={Boolean(hudLeg?.finished)}
        nm={isSuivre && live && !previewing ? (live.sailNm ?? cast?.sailNm ?? 0) : (cast?.sailNm ?? 0)}
        totalNm={playback.sailTotalNm || flatRoute.totalNm}
        playhead={isSuivre && live && !previewing ? (Number(live.filmNm) || playback.nm) : playback.nm}
        playheadTotal={playback.totalNm}
        remainingNm={hudLeg?.remainingNm ?? 0}
        etaHours={hudLeg?.etaHours}
        boatKnots={expeditionSpeed.knots}
        phase={cast?.phase}
        vehicle={cast?.vehicle}
        profile={playback.profile}
        onProfile={(profile) => sceneApiRef.current?.playback.setProfile(profile)}
        playing={playback.playing}
        onTogglePlay={() => {
          if (!isSimulation) return;
          sceneApiRef.current?.playback.toggle();
        }}
        marks={escaleMarks}
        onSeekNm={(nm) => {
          if (!isSimulation) return;
          sceneApiRef.current?.playback.pause();
          sceneApiRef.current?.playback.seek(nm, { jump: true });
        }}
        onNext={handleSimNext}
        canNext={playback.nm < ((escaleMarks.at(-1)?.filmNm ?? escaleMarks.at(-1)?.nm) ?? 0) - 1}
        showPlaybackControls={isSimulation}
        cinema={cinemaMode}
        onCinema={toggleCinema}
        hideBar={cinemaMode && hideFilmBar}
        onHideBar={setHideFilmBar}
        liveSpeed={expeditionSpeed.live}
        boatName={polarData?.boat_name}
        windSeries={windProfile.series}
        windLoading={windProfile.loading}
        holding={playback.holding}
        clockLine={clockLine}
        atQuay={atQuay}
        quayDays={quayDays}
        twa={clockSample?.twa}
        liveStatus={isSuivre ? (previewing ? t("previewBadge") : "LIVE") : null}
        windKind={clockSample?.kind === "forecast" ? "forecast" : (isSuivre ? null : (clockSample?.kind || expeditionSpeed.kind))}
        weatherLine={weatherLine}
        showSpeeds={isSimulation}
        showWindProfile={false}
        stopAuto={stopAuto}
        onStopAuto={setStopAuto}
        showStopAuto={isSimulation}
        sidebarOpen={sidebarOpen}
        toolsOpen={toolsOpen}
        eventMarks={filmEventMarks(iciPack.events, { mode: isSuivre ? "suivre" : "simulation" })}
        onEventClick={(ev) => {
          setSkipperClickId(ev.id || ev.stableKey);
          if (!isSimulation || !Number.isFinite(ev.filmCum)) return;
          sceneApiRef.current?.playback.pause();
          sceneApiRef.current?.playback.seek(ev.filmCum, { jump: true });
        }}
        storiesPending={(iciPack.events || []).filter((e) => e.story?.status === "pending").length}
        speechText={speechText}
        view={view}
        onView={drawingMode ? undefined : selectView}
        gribLine={isSuivre && official.gribStatus !== "ready" && official.gribStatus !== "pending" ? t("gribMissing") : ""}
        clock={officialClock}
        clockCurrent={clockSample ? {
          filmNm: isSuivre && live && !previewing ? (Number(live.filmNm) || 0) : playback.nm,
          sailNm: clockSample.sailNm,
          seaHours: clockSample.seaHours,
        } : null}
        disclaimer={t("creditsLine")}
      />

      <RecomputeDialog
        draft={vessel.draft}
        busy={vessel.busy}
        onAccept={async () => { await vessel.accept(); }}
        onReject={() => vessel.reject()}
      />

      {/* Sidebar rangée (Cinéma) : les cartes se posent sur la carte ; ouverte, elles vivent dans le produit « ici ». */}
      {!drawingMode && sceneReady && !sidebarOpen ? (
        <>
          <MomentNowCard
            card={moments.now}
            left={moments.nowLeft}
            onDismiss={moments.dismiss}
            onFocus={handleBriefingFocus}
          />
          <FreeMomentBlock
            card={moments.free}
            left={moments.freeLeft}
            onNext={moments.next}
            onFocus={handleBriefingFocus}
          />
        </>
      ) : null}

      <LayerFichePopup popup={layerPopup} onClose={() => setLayerPopup(null)} />

      {selectedSatellite && (
        <div className="naviguide-floating-card absolute left-1/2 -translate-x-1/2 z-[2100] w-[360px] bg-slate-900/96 border border-white/10 rounded-xl p-3 text-white text-xs shadow-2xl bottom-52">
          <button type="button" className="absolute top-2 right-2 text-slate-400" onClick={closeSatellite}><X size={14} /></button>
          <div className="font-semibold mb-2">{t("satelliteData")}</div>
          <div className="flex gap-1 mb-2">
            {["wind", "waves", "currents"].map((tab) => (
              <button key={tab} type="button" onClick={() => setSatelliteTab(tab)} className={`px-2 py-1 rounded ${satelliteTab === tab ? "bg-blue-600" : "bg-slate-800"}`}>
                {tab === "wind" ? t("windTab") : tab === "waves" ? t("wavesTab") : t("currentsTab")}
              </button>
            ))}
          </div>
          {satelliteTab === "wind" && (
            productHasData(selectedSatellite.wind, "wind")
              ? <SatelliteMetPanel kind="wind" product={selectedSatellite.wind} t={t} />
              : <p>{satelliteLoading || selectedSatellite.wind?.status === "pending" ? t("fetchingSatellite") : t("noWindData")}</p>
          )}
          {satelliteTab === "waves" && (
            productHasData(selectedSatellite.wave, "wave")
              ? <SatelliteMetPanel kind="wave" product={selectedSatellite.wave} t={t} />
              : <p>{satelliteLoading || selectedSatellite.wave?.status === "pending" ? t("fetchingSatellite") : t("noWaveData")}</p>
          )}
          {satelliteTab === "currents" && (
            productHasData(selectedSatellite.current, "current")
              ? <SatelliteMetPanel kind="current" product={selectedSatellite.current} t={t} />
              : <p>{satelliteLoading || selectedSatellite.current?.status === "pending" ? t("fetchingSatellite") : t("noCurrentData")}</p>
          )}
          {selectedSatellite.drawPointIndex != null && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <label className="block text-slate-400 mb-1">{t("waypointName")}</label>
              <input value={pointInfoName} onChange={(e) => setPointInfoName(e.target.value)} className="w-full bg-slate-800 rounded px-2 py-1" placeholder={t("waypointNamePlaceholder")} />
              <button type="button" onClick={handleSaveDrawPointMeta} className="mt-2 w-full bg-blue-600 rounded py-1">{t("saveClose")}</button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
