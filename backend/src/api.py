"""API HTTP (FastAPI) que expone el backend al frontend.

Arranque (desde la carpeta src):
    uvicorn api:app --reload --port 8000
Documentación interactiva: http://localhost:8000/docs

Los tiempos viajan dos veces: en segundos (para dibujar) y ya formateados en
texto mm:ss.ddd (para mostrar), de modo que el formato vive solo en Python.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path, PurePosixPath

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from config import (
    CATEGORY_LABELS, CORS_ORIGINS, DATA_DIR, MIN_CLEAN_LAPS_FOR_SLOPE, MS_SEPARATOR, PADDED_CAR_NUMBERS,
    SLOW_LAP_THRESHOLD, TOP_N_LAPS, TRAFFIC_THRESHOLD, TRAFFIC_WINDOW,
)
from analysis import (
    analyse_laps, clean_air_degradation, default_reference, driver_race_summary,
    gap_to_reference,
)
from degradation import stint_degradation
from classification import drivers_of, load_classification
from importer import (
    SUPPORTED_EXTENSIONS, file_kind, import_data, padded_numbers, read_categories,
    restore_padded_numbers, separate_shared_numbers,
)
from laps import (
    format_gap, format_hms, format_lap_time, lap_series, list_cars, list_categories,
    mark_pace_laps,
)
from metrics import (
    METRIC_COLUMNS, driver_summary, ranking_by_metric, session_bests,
)
from stints import mark_stints, stint_summary

REQUIRED_COLUMNS = [
    "NUMBER", "LAP_NUMBER", "LAP_TIME", "S1", "S2", "S3",
    "DRIVER_NAME", "CLASS", "TEAM", "HOUR", "ELAPSED",
]
DEFAULT_SLOW_PCT = round(SLOW_LAP_THRESHOLD * 100)

# Sesión virtual que junta todas las sesiones de la carpeta (p. ej. FP1 + FP2 + FP3).
OVERALL_ID = "__all__"
OVERALL_NAME = "Todas las sesiones"
TREND_MIN_LAPS = 3  # vueltas de ritmo mínimas para dibujar la tendencia de un stint

app = FastAPI(title="WEC Strategy API")
app.add_middleware(
    CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET"], allow_headers=["*"]
)


# ---------------------------------------------------------------------------
# Carga (con caché: importar un CSV cuesta, consultarlo no)
# ---------------------------------------------------------------------------
def _session_files() -> dict[str, Path]:
    """Todas las sesiones de todas las carpetas. El id es la ruta relativa a DATA_DIR
    (con "/"), p. ej. "WEC/2026/Barcelona/FP1.CSV". Se ignoran los temporales de Excel
    ("~$archivo.xlsx", que existen mientras el archivo está abierto) y los ocultos."""
    if not DATA_DIR.is_dir():
        return {}
    found = sorted(
        p for p in DATA_DIR.rglob("*")
        if p.is_file()
        and p.suffix.lower() in SUPPORTED_EXTENSIONS
        and not p.name.startswith(("~$", "."))
    )
    return {p.relative_to(DATA_DIR).as_posix(): p for p in found}


def _event_of(session_id: str) -> str:
    """Carpeta (evento) de una sesión; "." si el archivo está en la raíz."""
    return PurePosixPath(session_id).parent.as_posix()


def _event_name(event: str) -> str:
    """'ALMS/paul-ricard' -> 'ALMS · Paul Ricard'."""
    if event == ".":
        return DATA_DIR.name
    def pretty(part: str) -> str:
        text = part.replace("-", " ").replace("_", " ")
        return text.title() if text.islower() else text
    return " · ".join(pretty(part) for part in event.split("/"))


def _overall_id(event: str) -> str:
    return OVERALL_ID if event == "." else f"{event}/{OVERALL_ID}"


def _overall_event(session: str) -> str | None:
    """Evento al que pertenece una sesión 'todas las sesiones'; None si es una sesión normal."""
    if session == OVERALL_ID:
        return "."
    if session.endswith("/" + OVERALL_ID):
        return session[: -len(OVERALL_ID) - 1]
    return None


# Selección libre de archivos (de uno o varios eventos): "__sel__:id1|id2|...".
# "|" no puede aparecer en un nombre de archivo de Windows.
SELECTION_PREFIX = "__sel__:"
SELECTION_NAME = "Selección"


@lru_cache(maxsize=256)
def _kind_cached(path: str, modified: float) -> str:
    return file_kind(path)


def _kind(path: Path) -> str:
    return _kind_cached(str(path), path.stat().st_mtime)


def _event_files(event: str, kind: str | None = "analysis") -> list[Path]:
    """Archivos de un evento; por defecto solo los vuelta a vuelta (los que se analizan)."""
    return [
        p for sid, p in _session_files().items()
        if _event_of(sid) == event and (kind is None or _kind(p) == kind)
    ]


def _selection_ids(session: str) -> list[str] | None:
    if not session.startswith(SELECTION_PREFIX):
        return None
    return [s for s in session[len(SELECTION_PREFIX):].split("|") if s]


def _multi_paths(session: str) -> list[Path] | None:
    """Archivos de una sesión virtual (todas las de un evento o una selección);
    None si `session` es un archivo normal."""
    event = _overall_event(session)
    if event is not None:
        return _event_files(event)
    ids = _selection_ids(session)
    if ids is None:
        return None
    files = _session_files()
    paths = []
    for sid in dict.fromkeys(ids):
        path = files.get(sid)
        if path is None:
            raise HTTPException(404, f"No existe el archivo «{sid}».")
        if _kind(path) != "analysis":
            raise HTTPException(
                422, f"«{path.name}» no es un archivo de vueltas (Analysis): no se puede analizar."
            )
        paths.append(path)
    return paths


def _load(path: str, modified: float) -> tuple[pd.DataFrame, list[str]]:
    """Datos de la sesión y avisos para el usuario. Los números que perdieron los
    ceros ("7" en vez de "007") se recuperan con los demás archivos de su carpeta."""
    return _load_with(path, modified, _padded_for(Path(path)))


@lru_cache(maxsize=8)
def _load_with(
    path: str, modified: float, padded: tuple[tuple[str, tuple[str, ...]], ...]
) -> tuple[pd.DataFrame, list[str]]:
    """`modified` y `padded` solo sirven para invalidar la caché."""
    df = import_data(path, required_columns=REQUIRED_COLUMNS)
    df, restored = restore_padded_numbers(df, {team: set(numbers) for team, numbers in padded})
    df, notices = separate_shared_numbers(df)
    return df, restored + notices


def _padded_for(path: Path) -> tuple[tuple[str, tuple[str, ...]], ...]:
    siblings = sorted(
        p for p in path.parent.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS and not p.name.startswith(("~$", "."))
    )
    return _padded_cached(tuple((str(p), p.stat().st_mtime) for p in siblings))


@lru_cache(maxsize=16)
def _padded_cached(signature: tuple[tuple[str, float], ...]) -> tuple[tuple[str, tuple[str, ...]], ...]:
    found = padded_numbers([p for p, _ in signature], PADDED_CAR_NUMBERS)
    return tuple(sorted((team, tuple(sorted(numbers))) for team, numbers in found.items()))


@lru_cache(maxsize=32)
def _marked(path: str, modified: float, slow_pct: int) -> pd.DataFrame:
    df = mark_pace_laps(_load(path, modified)[0], slow_pct / 100)
    df["SESSION"] = Path(path).stem
    df["SESSION_LAP"] = df["LAP_NUMBER"]
    return df


@lru_cache(maxsize=8)
def _overall(signature: tuple[tuple[str, float], ...], slow_pct: int) -> pd.DataFrame:
    """Todas las sesiones juntas. Cada sesión se clasifica por separado (la vuelta
    lenta se mide contra la mejor del coche en ESA sesión). Como cada sesión
    empieza en la vuelta 1, LAP_NUMBER pasa a ser la vuelta acumulada del coche
    (FP1, luego FP2...) y SESSION_LAP conserva la vuelta dentro de su sesión."""
    frames = []
    for path, modified in signature:
        try:
            frames.append(_marked(path, modified, slow_pct))
        except Exception as error:
            raise ValueError(f"{Path(path).name}: {error}") from error
    df = pd.concat(frames, ignore_index=True)
    order = {name: i for i, name in enumerate(dict.fromkeys(df["SESSION"]))}
    df["_ORDER"] = df["SESSION"].map(order)
    df = df.sort_values(["NUMBER", "_ORDER", "SESSION_LAP"]).reset_index(drop=True)
    df["LAP_NUMBER"] = df.groupby("NUMBER").cumcount() + 1
    return df.drop(columns="_ORDER")


def _session_data(session: str, slow_pct: int = DEFAULT_SLOW_PCT) -> pd.DataFrame:
    files = _multi_paths(session)
    if files is not None and len(files) == 1:  # selección de un solo archivo
        session = next(sid for sid, p in _session_files().items() if p == files[0])
        files = None
    if files is not None:
        if len(files) < 2:
            raise HTTPException(404, "Para juntar sesiones hace falta más de un archivo de vueltas.")
        signature = tuple((str(p), p.stat().st_mtime) for p in files)
        try:
            return _overall(signature, slow_pct)
        except Exception as error:
            raise HTTPException(422, f"No se pudieron juntar las sesiones: {error}") from error
    # El nombre se busca entre los archivos de la carpeta: no se puede salir de ella.
    path = _session_files().get(session)
    if path is None:
        raise HTTPException(404, f"No existe la sesión «{session}».")
    if _kind(path) != "analysis":
        raise HTTPException(
            422,
            f"«{path.name}» no es un archivo de vueltas (Analysis). Las clasificaciones por "
            "horas se ven en «Clasificación por horas».",
        )
    try:
        return _marked(str(path), path.stat().st_mtime, slow_pct)
    except Exception as error:  # mensaje legible para la interfaz
        raise HTTPException(422, f"No se pudo importar {session}: {error}") from error


@lru_cache(maxsize=64)
def _categories(path: str, modified: float) -> tuple[str, ...] | None:
    """Categorías de un archivo (solo lee la columna CLASS). None si no se sabe."""
    found = read_categories(path)
    return None if found is None else tuple(found)


def _session_categories(path: Path) -> list[str] | None:
    found = _categories(str(path), path.stat().st_mtime)
    if found is None:
        return None
    return list_categories(pd.DataFrame({"CLASS": list(found)}))


def _session_notices(session: str) -> list[str]:
    paths = _multi_paths(session) or [_session_files()[session]]
    return [n for p in paths for n in _load(str(p), p.stat().st_mtime)[1]]


def _session_identity(session: str) -> tuple[str, str, bool]:
    """(nombre, evento, ¿junta varios archivos?) de cualquier tipo de sesión."""
    event = _overall_event(session)
    if event is not None:
        return OVERALL_NAME, event, True
    ids = _selection_ids(session)
    if ids is not None:
        if len(ids) == 1:
            return Path(ids[0]).stem, _event_of(ids[0]), False
        events = {_event_of(sid) for sid in ids}
        event = events.pop() if len(events) == 1 else "."
        return f"{SELECTION_NAME} ({len(ids)} archivos)", event, True
    return Path(session).stem, _event_of(session), False


# ---------------------------------------------------------------------------
# Serialización
# ---------------------------------------------------------------------------
def _num(value) -> float | None:
    return None if value is None or pd.isna(value) else float(value)


def _text(value) -> str:
    return "" if value is None or pd.isna(value) else str(value)


def _time(seconds) -> dict:
    return {"seconds": _num(seconds), "text": format_lap_time(seconds)}


def _median_gap_text(gap) -> str:
    if gap is None or pd.isna(gap):
        return "Sin vueltas de ritmo"
    return "Referencia" if gap == 0 else f"{format_gap(gap)} s"


def _best(row) -> dict:
    return {
        "key": row.KEY,
        "label": row.METRIC,
        **_time(row.TIME),
        "car": row.CAR,
        "team": _text(row.TEAM),
        "session": _text(row.SESSION),
        "driver": row.DRIVER,
        "lap": int(row.LAP),
        "clock": format_hms(row.CLOCK),
        "elapsed": format_hms(row.ELAPSED),
    }


def _ranking(ranking: pd.DataFrame) -> list[dict]:
    return [
        {
            "position": int(r.POSITION),
            "car": r.CAR,
            "team": _text(r.TEAM),
            "driver": r.DRIVER,
            "session": _text(r.SESSION),
            **_time(r.TIME),
            "gapText": "—" if r.POSITION == 1 else format_gap(r.GAP),
            "lap": int(r.LAP),
            "clock": format_hms(r.CLOCK),
        }
        for r in ranking.itertuples()
    ]


def _stints(car: pd.DataFrame) -> list[dict]:
    """Stints del coche con su tendencia de ritmo (None si hay pocas vueltas)."""
    trends = stint_degradation(car, min_laps=TREND_MIN_LAPS).set_index("STINT")
    stints = []
    for r in stint_summary(car).itertuples():
        trend = None
        if r.STINT in trends.index:
            fit = trends.loc[r.STINT]
            trend = {
                "slope": float(fit["NET_SLOPE"]),
                "intercept": float(fit["INTERCEPT"]),
                "r2": _num(fit["R2"]),
            }
        stints.append(
            {
                "stint": int(r.STINT),
                "driver": r.DRIVER_NAME,
                "startLap": int(r.START_LAP),
                "endLap": int(r.END_LAP),
                "laps": int(r.LAPS),
                "paceLaps": int(r.PACE_LAPS),
                "best": _time(r.BEST_LAP),
                "median": _time(r.MEDIAN_PACE),
                "trend": trend,
            }
        )
    return stints


def _pit_stops(car: pd.DataFrame) -> list[dict]:
    """Paradas en boxes del coche: el paso de un stint al siguiente.

    Sale el piloto del stint que termina y entra el del que empieza (si es el mismo,
    no hay relevo). La duración es el tiempo en boxes de la vuelta de salida. Ni la
    espera inicial del primer stint ni el cambio de una sesión a otra en "todas las
    sesiones" cuentan como parada.
    """
    stints = stint_summary(car).sort_values("STINT")
    session_of = car.set_index("LAP_NUMBER")["SESSION"]
    stops: list[dict] = []
    previous = None
    for r in stints.itertuples():
        if previous is not None and session_of[previous.END_LAP] == session_of[r.START_LAP]:
            stops.append(
                {
                    "fromLap": int(previous.END_LAP),   # vuelta de entrada a boxes
                    "toLap": int(r.START_LAP),          # vuelta de salida
                    "driverOut": previous.DRIVER_NAME,
                    "driverIn": r.DRIVER_NAME,
                    "driverChange": bool(previous.DRIVER_NAME != r.DRIVER_NAME),
                    "pit": _time(r.PIT_BEFORE_SECONDS),
                }
            )
        previous = r
    return stops


def _pit_group(stops: list[dict]) -> dict:
    """Nº de paradas con tiempo, media, mejor y peor. Las paradas sin tiempo registrado
    no entran en la media."""
    times = [s["pit"]["seconds"] for s in stops if s["pit"]["seconds"] is not None]
    if not times:
        return {"count": 0, "mean": _time(None), "best": _time(None), "worst": _time(None)}
    return {
        "count": len(times),
        "mean": _time(sum(times) / len(times)),
        "best": _time(min(times)),
        "worst": _time(max(times)),
    }


def _pit_summary(stops: list[dict]) -> dict:
    """Tiempo de parada con cambio de piloto y sin él."""
    return {
        "withChange": _pit_group([s for s in stops if s["driverChange"]]),
        "withoutChange": _pit_group([s for s in stops if not s["driverChange"]]),
    }


def _pace_points(df: pd.DataFrame, car: str) -> list[dict]:
    laps = df[(df["NUMBER"] == car) & df["IS_PACE_LAP"]].sort_values("LAP_NUMBER")
    return [
        {
            "lap": int(r.LAP_NUMBER),
            "seconds": _num(r.LAP_TIME_SECONDS),
            "driver": r.DRIVER_NAME,
            "session": r.SESSION,
            "sessionLap": int(r.SESSION_LAP),
        }
        for r in laps.itertuples()
    ]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/sessions")
def sessions() -> dict:
    """Sesiones disponibles (archivos vuelta a vuelta), todos los archivos con su tipo
    (para elegir cuáles analizar), eventos con clasificaciones por horas y ajustes."""
    by_event: dict[str, list[dict]] = {}
    files: list[dict] = []
    classifications: dict[str, int] = {}
    for name, path in _session_files().items():
        event = _event_of(name)
        kind = _kind(path)
        files.append(
            {
                "id": name, "name": path.stem, "event": event, "eventName": _event_name(event),
                "kind": kind, "categories": _session_categories(path) if kind == "analysis" else None,
                "sizeKb": round(path.stat().st_size / 1024),
            }
        )
        if kind == "classification":
            classifications[event] = classifications.get(event, 0) + 1
        if kind != "analysis":
            continue
        by_event.setdefault(event, []).append(
            {
                "id": name,
                "name": Path(name).stem,
                "overall": False,
                "event": event,
                "eventName": _event_name(event),
                "categories": _session_categories(path),
            }
        )
    items: list[dict] = []
    for event, group in by_event.items():
        items.extend(group)
        if len(group) >= 2:  # la sesión que junta las de ese evento, al final de su grupo
            known = [item["categories"] for item in group]
            union = None
            if all(c is not None for c in known):
                union = list_categories(pd.DataFrame({"CLASS": sorted({c for cs in known for c in cs})}))
            items.append(
                {
                    "id": _overall_id(event), "name": OVERALL_NAME, "overall": True,
                    "event": event, "eventName": _event_name(event), "categories": union,
                }
            )
    return {
        "sessions": items,
        "files": files,
        "classifications": [
            {"event": event, "eventName": _event_name(event), "files": count}
            for event, count in classifications.items()
        ],
        "settings": {"msSeparator": MS_SEPARATOR, "slowThresholdPct": DEFAULT_SLOW_PCT},
        "dataDir": str(DATA_DIR),
    }


@app.get("/api/sessions/{session:path}/overview")
def overview(session: str) -> dict:
    """Resumen de la sesión y de cada categoría (pantalla de inicio)."""
    df = _session_data(session)
    name, event, overall = _session_identity(session)
    categories = []
    for category in list_categories(df):
        data = df[df["CLASS"] == category]
        categories.append(
            {
                "id": category,
                "label": CATEGORY_LABELS.get(category, category),
                "cars": int(data["NUMBER"].nunique()),
                "drivers": int(data["DRIVER_NAME"].nunique()),
                "laps": len(data),
                "bestLap": _best(next(session_bests(data).itertuples())),
            }
        )
    return {
        "session": {
            "id": session,
            "name": name,
            "event": event,
            "eventName": _event_name(event),
        },
        "overall": overall,
        "sessionCount": int(df["SESSION"].nunique()),
        "notices": _session_notices(session),
        "laps": len(df),
        "cars": int(df["NUMBER"].nunique()),
        "drivers": int(df["DRIVER_NAME"].nunique()),
        # la hora del día solo tiene sentido dentro de una sesión
        "clockStart": "" if overall else format_hms(df["HOUR_SECONDS"].min()),
        "clockEnd": "" if overall else format_hms(df["HOUR_SECONDS"].max()),
        "categories": categories,
    }


@app.get("/api/sessions/{session:path}/categories/{category}")
def category_view(
    session: str, category: str, slow: int = Query(DEFAULT_SLOW_PCT, ge=100, le=200)
) -> dict:
    """Todo lo que muestra el panel de una categoría: mejores tiempos, clasificación
    por vuelta y sector, ritmo por vuelta de cada coche (del más rápido al más lento) y lista de coches."""
    df = _session_data(session, slow)
    data = df[df["CLASS"] == category]
    if data.empty:
        raise HTTPException(404, f"No existe la categoría «{category}» en esta sesión.")

    rankings = {key: ranking_by_metric(data, column) for key, column in METRIC_COLUMNS.items()}
    cars = list_cars(df, category)

    return {
        "category": {"id": category, "label": CATEGORY_LABELS.get(category, category)},
        "counts": {
            "laps": len(data),
            "paceLaps": int(data["IS_PACE_LAP"].sum()),
            "cars": int(data["NUMBER"].nunique()),
            "drivers": int(data["DRIVER_NAME"].nunique()),
        },
        "bests": [_best(row) for row in session_bests(data).itertuples()],
        "rankings": {key: _ranking(ranking) for key, ranking in rankings.items()},
        "pace": [
            {"car": r.CAR, "team": _text(r.TEAM), "laps": _pace_points(data, r.CAR)}
            for r in rankings["lap"].itertuples()
        ],
        "cars": [
            {
                "number": r.NUMBER,
                "team": _text(r.TEAM),
                "manufacturer": _text(r.MANUFACTURER),
                "drivers": list(r.DRIVERS),
            }
            for r in cars.itertuples()
        ],
    }


@app.get("/api/sessions/{session:path}/cars/{number}")
def car_view(
    session: str, number: str, slow: int = Query(DEFAULT_SLOW_PCT, ge=100, le=200)
) -> dict:
    """Un coche: KPIs por piloto, paradas en boxes y todas sus vueltas (con su estado)."""
    df = _session_data(session, slow)
    car = df[df["NUMBER"] == number]
    if car.empty:
        raise HTTPException(404, f"No existe el coche «{number}» en esta sesión.")
    car = mark_stints(car)

    drivers = driver_summary(car)
    fastest = drivers["BEST_LAP"].min()
    series = lap_series(car)
    stops = _pit_stops(car)

    return {
        "car": {
            "number": number,
            "team": _text(car["TEAM"].iloc[0]),
            "manufacturer": _text(car["MANUFACTURER"].iloc[0]) if "MANUFACTURER" in car else "",
            "category": car["CLASS"].iloc[0],
        },
        "counts": {"laps": len(car), "paceLaps": int(car["IS_PACE_LAP"].sum())},
        "drivers": [
            {
                "name": r.DRIVER_NAME,
                "laps": int(r.LAPS),
                "paceLaps": int(r.PACE_LAPS),
                "best": _time(r.BEST_LAP),
                "s1": _time(r.BEST_S1),
                "s2": _time(r.BEST_S2),
                "s3": _time(r.BEST_S3),
                "median": _time(r.MEDIAN_PACE),
                "mean": _time(r.MEAN_PACE),
                "meanGap": {"seconds": _num(r.MEAN_GAP), "text": _median_gap_text(r.MEAN_GAP)},
                "medianGap": {"seconds": _num(r.MEDIAN_GAP), "text": _median_gap_text(r.MEDIAN_GAP)},
                "deltaText": (
                    "Referencia"
                    if r.BEST_LAP == fastest
                    else f"{format_gap(r.BEST_LAP - fastest)} s"
                ),
            }
            for r in drivers.itertuples()
        ],
        "stints": _stints(car),
        "pitStops": stops,
        "pitSummary": _pit_summary(stops),
        "laps": [
            {
                "lap": int(r.LAP_NUMBER),
                "stint": int(r.STINT),
                "stintLap": int(r.STINT_LAP),
                "session": r.SESSION,
                "sessionLap": int(r.SESSION_LAP),
                "driver": r.DRIVER_NAME,
                **_time(r.LAP_TIME_SECONDS),
                "s1": r.S1_TEXT,
                "s2": r.S2_TEXT,
                "s3": r.S3_TEXT,
                "clock": r.CLOCK_TEXT,
                "status": r.LAP_STATUS,
                "flag": r.FLAG,
                "pit": "in" if r.IS_IN_LAP else "out" if r.IS_OUT_LAP else "",
                "isPace": bool(r.IS_PACE_LAP),
            }
            for r in series.itertuples()
        ],
    }


# ---------------------------------------------------------------------------
# Análisis de carrera (estado de vuelta, tráfico, degradación, gaps)
#
# Campos en snake_case, tiempos en segundos (float, null si no hay dato).
# Solo para sesiones individuales: ELAPSED no es comparable entre sesiones.
# ---------------------------------------------------------------------------
@lru_cache(maxsize=8)
def _analysed(path: str, modified: float) -> pd.DataFrame:
    df = analyse_laps(_load(path, modified)[0])
    df["SESSION"] = Path(path).stem
    return df


def _analysis_data(session: str) -> pd.DataFrame:
    multi = _multi_paths(session)
    if multi is not None and len(multi) != 1:
        raise HTTPException(
            400, "El análisis de carrera solo está disponible para una sesión concreta."
        )
    path = multi[0] if multi else _session_files().get(session)
    if path is None:
        raise HTTPException(404, f"No existe la sesión «{session}».")
    if _kind(path) != "analysis":
        raise HTTPException(422, f"«{path.name}» no es un archivo de vueltas (Analysis).")
    try:
        return _analysed(str(path), path.stat().st_mtime)
    except Exception as error:
        raise HTTPException(422, f"No se pudo analizar {session}: {error}") from error


def _filter(df: pd.DataFrame, category: str | None, car: str | None = None) -> pd.DataFrame:
    if category is not None:
        df = df[df["CLASS"] == category]
        if df.empty:
            raise HTTPException(404, f"No existe la categoría «{category}» en esta sesión.")
    if car is not None:
        df = df[df["NUMBER"] == car]
        if df.empty:
            raise HTTPException(404, f"No existe el coche «{car}» en esta sesión.")
    return df


def _with_reference(df: pd.DataFrame, scope: pd.DataFrame, reference: str | None) -> tuple[pd.DataFrame, str | None]:
    """Gaps calculados sobre la sesión completa `df` (la referencia puede ser de otra
    categoría). Sin referencia explícita se usa el líder de `scope`."""
    reference = reference or default_reference(scope)
    if reference is None:
        out = df.copy()
        out["gap_to_reference"] = float("nan")
        return out, None
    try:
        return gap_to_reference(df, reference), reference
    except KeyError:
        raise HTTPException(404, f"No existe el coche de referencia «{reference}».") from None


def _int(value) -> int | None:
    return None if value is None or pd.isna(value) else int(value)


def _analysis_lap(r) -> dict:
    return {
        "lap": int(r.LAP_NUMBER),
        "car": r.NUMBER,
        "category": _text(r.CLASS),
        "team": _text(r.TEAM),
        "driver": _text(r.DRIVER_NAME),
        "driver_number": _int(getattr(r, "DRIVER_NUMBER", None)),
        "stint": int(r.stint),
        "stint_lap": int(r.stint_lap),
        "lap_time": _num(r.LAP_TIME_SECONDS),
        "lap_time_text": format_lap_time(r.LAP_TIME_SECONDS),
        "s1": _num(r.S1_SECONDS),
        "s2": _num(r.S2_SECONDS),
        "s3": _num(r.S3_SECONDS),
        "s1_reference": _num(r.S1_REFERENCE),
        "s2_reference": _num(r.S2_REFERENCE),
        "s3_reference": _num(r.S3_REFERENCE),
        "pit_time": _num(getattr(r, "PIT_TIME_SECONDS", None)),
        "elapsed": _num(r.ELAPSED_SECONDS),
        "flag": _text(getattr(r, "FLAG_AT_FL", None)),
        "is_in_lap": bool(r.is_in_lap),
        "is_out_lap": bool(r.is_out_lap),
        "is_neutralized": bool(r.is_neutralized),
        "is_green_racing": bool(r.is_green_racing),
        "is_clean_air": bool(r.is_clean_air),
        "traffic_loss": _num(r.traffic_loss),
        "gap_to_reference": _num(r.gap_to_reference),
    }


def _analysis_settings() -> dict:
    return {
        "traffic_window": TRAFFIC_WINDOW,
        "traffic_threshold": TRAFFIC_THRESHOLD,
        "min_clean_laps_for_slope": MIN_CLEAN_LAPS_FOR_SLOPE,
        "top_n_laps": TOP_N_LAPS,
    }


@app.get("/api/sessions/{session:path}/analysis/laps")
def analysis_laps(
    session: str,
    category: str | None = None,
    car: str | None = None,
    reference: str | None = None,
) -> dict:
    """Todas las vueltas (de una categoría y/o coche) con su estado, sectores en
    segundos, referencia de sector, tráfico estimado y gap al coche de referencia."""
    df = _analysis_data(session)
    scope = _filter(df, category)
    df, reference = _with_reference(df, scope, reference)
    laps = _filter(df, category, car)
    return {
        "session": session,
        "reference": reference,
        "settings": _analysis_settings(),
        "laps": [_analysis_lap(r) for r in laps.itertuples()],
    }


@app.get("/api/sessions/{session:path}/analysis/stints")
def analysis_stints(
    session: str,
    category: str | None = None,
    car: str | None = None,
    min_laps: int = Query(MIN_CLEAN_LAPS_FOR_SLOPE, ge=2, le=100),
) -> dict:
    """Stints (DRIVER_NUMBER + paradas) con la pendiente de degradación en aire limpio
    (s/vuelta; null si el stint no tiene `min_laps` vueltas limpias)."""
    data = _filter(_analysis_data(session), category, car)
    stints = clean_air_degradation(data, min_laps=min_laps)
    return {
        "session": session,
        "min_laps": min_laps,
        "stints": [
            {
                "car": r.NUMBER,
                "category": _text(r.CLASS),
                "team": _text(r.TEAM),
                "stint": int(r.stint),
                "driver": _text(r.DRIVER_NAME),
                "driver_number": _int(r.DRIVER_NUMBER),
                "start_lap": int(r.start_lap),
                "end_lap": int(r.end_lap),
                "laps": int(r.laps),
                "clean_laps": int(r.clean_laps),
                "slope": _num(r.slope),
                "intercept": _num(r.intercept),
                "r2": _num(r.r2),
            }
            for r in stints.itertuples()
        ],
    }


@app.get("/api/sessions/{session:path}/analysis/gaps")
def analysis_gaps(
    session: str, category: str | None = None, reference: str | None = None
) -> dict:
    """Serie de gap_to_reference por coche, lista para dibujar (una línea por coche)."""
    df = _analysis_data(session)
    scope = _filter(df, category)
    df, reference = _with_reference(df, scope, reference)
    data = _filter(df, category)
    cars = []
    for number, laps in data.groupby("NUMBER", sort=False):
        first = laps.iloc[0]
        cars.append(
            {
                "car": number,
                "category": _text(first["CLASS"]),
                "team": _text(first["TEAM"]),
                "laps": [
                    {
                        "lap": int(r.LAP_NUMBER),
                        "elapsed": _num(r.ELAPSED_SECONDS),
                        "gap_to_reference": _num(r.gap_to_reference),
                        "is_neutralized": bool(r.is_neutralized),
                        "is_in_lap": bool(r.is_in_lap),
                    }
                    for r in laps.itertuples()
                ],
            }
        )
    return {"session": session, "reference": reference, "cars": cars}


@app.get("/api/sessions/{session:path}/analysis/drivers")
def analysis_drivers(
    session: str,
    category: str | None = None,
    car: str | None = None,
    top_n: int = Query(TOP_N_LAPS, ge=1, le=100),
) -> dict:
    """Resumen por piloto: mejor vuelta, media de las top_n mejores vueltas verdes,
    desviación típica y tiempo total perdido en tráfico."""
    data = _filter(_analysis_data(session), category, car)
    summary = driver_race_summary(data, top_n=top_n)
    return {
        "session": session,
        "top_n": top_n,
        "drivers": [
            {
                "car": r.NUMBER,
                "category": _text(r.CLASS),
                "team": _text(r.TEAM),
                "driver": _text(r.DRIVER_NAME),
                "driver_number": _int(r.DRIVER_NUMBER),
                "laps": int(r.laps),
                "green_laps": int(r.green_laps),
                "best_lap": _num(r.best_lap),
                "best_lap_text": format_lap_time(r.best_lap),
                "top_n_average": _num(r.top_n_average),
                "top_n_average_text": format_lap_time(r.top_n_average),
                "top_n_laps": int(r.top_n_laps),
                "std_dev": _num(r.std_dev),
                "traffic_laps": int(r.traffic_laps),
                "total_traffic_loss": _num(r.total_traffic_loss),
            }
            for r in summary.itertuples()
        ],
    }


# ---------------------------------------------------------------------------
# Clasificación por horas (…_Classification_Race_Hour N.CSV de un mismo evento)
# ---------------------------------------------------------------------------
@lru_cache(maxsize=8)
def _classification(signature: tuple[tuple[str, float], ...]) -> tuple[pd.DataFrame, list[str]]:
    paths = [Path(p) for p, _ in signature]
    df = load_classification(paths)
    padded = {team: set(numbers) for team, numbers in _padded_for(paths[0])}
    return restore_padded_numbers(df, padded)


@app.get("/api/events/{event:path}/classification")
def classification(event: str) -> dict:
    """Evolución hora a hora: posición (general y en clase), vueltas, diferencias, ritmo
    frente al líder de la clase y vuelta rápida de cada coche."""
    paths = _event_files(event, kind="classification")
    if not paths:
        raise HTTPException(404, f"No hay clasificaciones por horas en «{event}».")
    try:
        df, notices = _classification(tuple((str(p), p.stat().st_mtime) for p in paths))
    except Exception as error:
        raise HTTPException(422, f"No se pudieron leer las clasificaciones: {error}") from error

    last_hour = int(df["HOUR"].max())
    final = df[df["HOUR"] == last_hour].set_index("NUMBER")["POSITION"]
    cars = []
    for number, rows in df.groupby("NUMBER", sort=False):
        rows = rows.sort_values("HOUR")
        last = rows.iloc[-1]
        cars.append(
            {
                "number": number,
                "team": _text(last.get("TEAM")),
                "vehicle": _text(last.get("VEHICLE")),
                "category": _text(last.get("CLASS")),
                "tyres": _text(last.get("TYRES")),
                "drivers": drivers_of(last),
                "finalPosition": _int_or_none(final.get(number)),
                "snapshots": [
                    {
                        "hour": int(r.HOUR),
                        "position": _int_or_none(r.POSITION),
                        "classPosition": int(r.CLASS_POSITION),
                        "laps": _int_or_none(r.LAPS),
                        "status": _text(getattr(r, "STATUS", "")),
                        "totalTime": _num(r.TOTAL_SECONDS),
                        "gapFirst": _text(getattr(r, "GAP_FIRST", "")),
                        "gapSeconds": _num(r.GAP_SECONDS),
                        "lapsDown": int(r.LAPS_DOWN),
                        "leaderDelta": _num(r.LEADER_DELTA),
                        "bestLap": _time(r.BEST_SECONDS),
                        "bestLapNumber": _int_or_none(pd.to_numeric(getattr(r, "FL_LAPNUM", None), errors="coerce")),
                    }
                    for r in rows.itertuples()
                ],
            }
        )
    cars.sort(key=lambda c: (c["finalPosition"] is None, c["finalPosition"] or 0))
    categories = list_categories(df[df["CLASS"] != ""]) if (df["CLASS"] != "").any() else []
    return {
        "event": event,
        "eventName": _event_name(event),
        "hours": sorted(int(h) for h in df["HOUR"].unique()),
        "categories": [{"id": c, "label": CATEGORY_LABELS.get(c, c)} for c in categories],
        "notices": notices,
        "cars": cars,
    }


def _int_or_none(value) -> int | None:
    return None if value is None or pd.isna(value) else int(value)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api:app", host="127.0.0.1", port=8000)