"""Fuentes de datos para el colector. Todas devuelven `Snapshot` (o None si no hay datos).

LmuRestSource   API web local de Le Mans Ultimate (motor rFactor 2): la misma que usa la
                interfaz del juego. rFactor 2 la sirve en http://localhost:5397 y LMU en
                http://localhost:6397, con /rest/watch/sessionInfo y /rest/watch/standings.
                ⚠ Los nombres de campo vienen de rFactor 2 y NO se han podido comprobar con
                LMU: `map_rest` acepta varias variantes y `--probe` guarda lo que devuelve
                el juego para ajustarlo. Revisar con el juego abierto (ver README).
ReplaySource    reproduce una grabación (--record) para probar sin el juego.
SimulatedSource carrera multiclase inventada (paradas, relevos, FCY, tráfico) para probar
                el colector y la app ahora mismo.
"""

from __future__ import annotations

import gzip
import json
import math
import random
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

from lap_builder import CarState, SessionState, Snapshot

# ---------------------------------------------------------------------------
# Mapeo de la API REST de rFactor 2 / LMU
# ---------------------------------------------------------------------------
# gamePhase de rFactor 2: 5 = verde, 6 = full course yellow, 7 = sesión parada, 8 = terminada
_PHASE_FLAG = {5: "GF", 6: "FCY", 7: "RF", 8: "FF"}
_PIT_STATES = {"ENTERING", "STOPPED", "EXITING", "REQUEST_IN_PIT", "IN_PIT", "1", "2", "3", "4"}


def _get(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Primer campo que exista (las versiones del juego cambian nombres)."""
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return default


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) or number <= 0 else number


def _speed(car: dict[str, Any]) -> float | None:
    v = _get(car, "carVelocity", "velocity", "speed")
    if isinstance(v, dict):
        if "velocity" in v:
            return _num(v["velocity"])
        parts = [float(v.get(k, 0) or 0) for k in ("x", "y", "z")]
        return math.sqrt(sum(p * p for p in parts)) or None
    return _num(v)


def wec_class(raw: str) -> str:
    text = (raw or "").lower()
    if "hyper" in text or "lmh" in text or "lmdh" in text:
        return "HYPERCAR"
    if "gt3" in text:
        return "LMGT3"
    if "gte" in text:
        return "LMGTE"
    if "lmp2" in text or "p2" == text:
        return "LMP2"
    if "lmp3" in text:
        return "LMP3"
    return (raw or "").upper()


def car_number(car: dict[str, Any]) -> str:
    """Número del coche tal cual (con ceros: "007"). Si no viene suelto, se saca de
    "#007 Aston Martin..." en el nombre del vehículo."""
    explicit = _get(car, "carNumber", "number", "vehicleNumber")
    if explicit not in (None, ""):
        return str(explicit).strip()
    for key in ("vehicleName", "carName", "vehicleFilename"):
        match = re.search(r"#\s*(\d+)", str(car.get(key, "")))
        if match:
            return match.group(1)
    return str(_get(car, "slotID", "slotId", "id", default="?"))


def map_rest(session: dict[str, Any], standings: list[dict[str, Any]]) -> Snapshot:
    phase = _get(session, "gamePhase", "phase")
    try:
        phase = int(phase)
    except (TypeError, ValueError):
        pass
    flag = _PHASE_FLAG.get(phase, "GF") if isinstance(phase, int) else "GF"
    yellow = str(_get(session, "yellowFlagState", default="NOFLAG")).upper()
    if flag == "GF" and yellow not in ("NOFLAG", "0", "", "NONE", "-1"):
        flag = "FCY"
    if _get(session, "safetyCarActive", "safetyCar") in (True, 1, "true"):
        flag = "SC"
    state = SessionState(
        time=float(_get(session, "currentEventTime", "currentET", "sessionTime", default=0) or 0),
        session=str(_get(session, "session", "sessionType", default="SESSION")).upper(),
        track=str(_get(session, "trackName", "track", default="Track")),
        flag=flag,
        track_length=_num(_get(session, "lapDistance", "trackLength")),
    )
    cars = []
    for car in standings:
        pit_state = str(_get(car, "pitState", default="")).upper()
        in_pits = bool(
            _get(car, "pitting", "inPits", default=False)
            or _get(car, "inGarageStall", default=False)
            or pit_state in _PIT_STATES
        )
        vehicle = str(_get(car, "vehicleName", "carName", default=""))
        team = str(_get(car, "fullTeamName", "teamName", default="")) or re.sub(r"#\s*\d+\s*", "", vehicle).strip()
        cars.append(
            CarState(
                slot=str(_get(car, "slotID", "slotId", "id", default=car_number(car))),
                number=car_number(car),
                team=team,
                vehicle=str(_get(car, "carType", "vehicleClassName", default=vehicle)),
                car_class=wec_class(str(_get(car, "carClass", "vehicleClass", "class", default=""))),
                driver=str(_get(car, "driverName", "driver", default="")),
                laps_completed=int(_get(car, "lapsCompleted", "totalLaps", "laps", default=0) or 0),
                last_lap=_num(_get(car, "lastLapTime", "lastLap")),
                last_s1=_num(_get(car, "lastSectorTime1", "lastSector1")),
                last_s2_cumulative=_num(_get(car, "lastSectorTime2", "lastSector2")),
                in_pits=in_pits,
                speed=_speed(car),
            )
        )
    return Snapshot(session=state, cars=cars)


class LmuRestSource:
    def __init__(self, base_url: str = "http://localhost:6397", timeout: float = 2.0, record: Path | None = None):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.record_path = record  # se abre con los primeros datos (sin archivos vacíos)
        self.record = None
        self.last_error = ""

    def _json(self, path: str) -> Any:
        with urllib.request.urlopen(self.base + path, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def raw(self) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
        try:
            session = self._json("/rest/watch/sessionInfo")
            standings = self._json("/rest/watch/standings")
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            self.last_error = str(error)
            return None
        if isinstance(standings, dict):  # algunas versiones envuelven la lista
            standings = _get(standings, "vehicles", "standings", default=[])
        return session, standings

    def read(self) -> Snapshot | None:
        raw = self.raw()
        if raw is None:
            return None
        if self.record_path:
            if self.record is None:
                self.record = gzip.open(self.record_path, "at", encoding="utf-8")
            self.record.write(json.dumps({"t": time.time(), "session": raw[0], "standings": raw[1]}) + "\n")
            self.record.flush()
        return map_rest(*raw)


class ReplaySource:
    """Reproduce una grabación .jsonl.gz de LmuRestSource (lo más rápido posible)."""

    def __init__(self, path: Path):
        self.lines: Iterator[str] = iter(gzip.open(path, "rt", encoding="utf-8"))
        self.finished = False

    def read(self) -> Snapshot | None:
        for line in self.lines:
            item = json.loads(line)
            snap = map_rest(item["session"], item["standings"])
            snap.wall_clock = datetime.fromtimestamp(item["t"])
            return snap
        self.finished = True
        return None


# ---------------------------------------------------------------------------
# Carrera simulada
# ---------------------------------------------------------------------------
_SIM_GRID = [
    ("7", "Toyota Racing (sim)", "Toyota TR010", "Hyper", 205.0),
    ("50", "Ferrari AF Corse (sim)", "Ferrari 499P", "Hyper", 205.4),
    ("6", "Porsche Penske (sim)", "Porsche 963", "Hyper", 205.9),
    ("007", "Aston Martin THOR (sim)", "Aston Martin Valkyrie", "Hyper", 206.6),
    ("22", "United Autosports (sim)", "Oreca 07", "LMP2", 213.0),
    ("43", "Inter Europol (sim)", "Oreca 07", "LMP2", 213.4),
    ("92", "Manthey (sim)", "Porsche 911 GT3 R", "GT3", 233.0),
    ("31", "Team WRT (sim)", "BMW M4 GT3", "GT3", 233.5),
]


class SimulatedSource:
    """Carrera inventada a `speed`× velocidad real: vueltas con desgaste, tráfico, paradas
    cada `stint_laps` vueltas con relevo, y un periodo de FCY."""

    def __init__(self, speed: float = 20.0, seed: int = 7, stint_laps: int = 12):
        self.rng = random.Random(seed)
        self.speed = speed
        self.start = time.monotonic()
        self.wall_start = datetime.now()
        self.stint_laps = stint_laps
        self.track_length = 13626.0
        self.cars = []
        for i, (number, team, vehicle, cls, pace) in enumerate(_SIM_GRID):
            self.cars.append(
                {
                    "slot": str(i), "number": number, "team": team, "vehicle": vehicle, "class": cls,
                    "pace": pace, "drivers": [f"Driver {number}-{d}" for d in "ABC"], "driver": 0,
                    "laps": 0, "lap_start": -i * 1.5, "stint_lap": 0, "plan": [], "last": None,
                    "pit_until": None,
                }
            )

    def _session_time(self) -> float:
        return (time.monotonic() - self.start) * self.speed

    def _plan_lap(self, car: dict[str, Any], fcy: bool) -> None:
        car["stint_lap"] += 1
        lap = car["pace"] + 0.06 * car["stint_lap"] + self.rng.gauss(0, 0.35)
        if self.rng.random() < 0.15:
            lap += self.rng.uniform(0.5, 2.5)  # tráfico
        if fcy:
            lap += 40.0
        pit = car["stint_lap"] >= self.stint_laps
        sectors = [lap * 0.31, lap * 0.36, lap * 0.33]
        if pit:
            sectors[2] += 18.0  # entrada al pit lane al final de la vuelta
        if car.get("out_lap"):
            sectors[0] += 70.0  # vuelta de salida: incluye la parada (70 s en el pit lane)
            car["out_lap"] = False
        car["plan"] = sectors
        car["planned_pit"] = pit

    def read(self) -> Snapshot | None:
        now = self._session_time()
        fcy = 3000 < now < 3400
        for car in self.cars:
            if not car["plan"]:
                self._plan_lap(car, fcy)
            if car["pit_until"] is not None and now >= car["pit_until"]:
                car["pit_until"] = None  # sale del pit lane
            lap_time = sum(car["plan"])
            if now >= car["lap_start"] + lap_time:
                car["laps"] += 1
                car["last"] = (lap_time, car["plan"][0], car["plan"][0] + car["plan"][1])
                car["lap_start"] += lap_time
                if car.get("planned_pit"):
                    # cruza la meta dentro del pit lane: 70 s de parada con relevo
                    car["pit_until"] = car["lap_start"] + 70.0
                    car["driver"] = (car["driver"] + 1) % len(car["drivers"])
                    car["stint_lap"] = 0
                    car["out_lap"] = True
                self._plan_lap(car, fcy)
        cars = []
        for car in self.cars:
            last = car["last"] or (None, None, None)
            in_pits = car["pit_until"] is not None or (
                car.get("planned_pit") and now >= car["lap_start"] + sum(car["plan"]) - 18.0
            )
            cars.append(
                CarState(
                    slot=car["slot"], number=car["number"], team=car["team"], vehicle=car["vehicle"],
                    car_class=wec_class(car["class"]), driver=car["drivers"][car["driver"]],
                    laps_completed=car["laps"], last_lap=last[0], last_s1=last[1],
                    last_s2_cumulative=last[2], in_pits=bool(in_pits),
                    speed=None if in_pits else self.rng.uniform(70, 92),
                )
            )
        return Snapshot(
            session=SessionState(time=now, session="RACE", track="Le Mans (sim)",
                                 flag="FCY" if fcy else "GF", track_length=self.track_length),
            cars=cars,
            wall_clock=self.wall_start + timedelta(seconds=now),
        )
