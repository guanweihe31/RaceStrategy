"""De "fotos" del estado de cada coche a vueltas completas en formato Al Kamel.

La fuente (LMU, simulación, grabación) entrega cada X ms un `Snapshot`: el estado de
la sesión y de cada coche en ese instante. `LapBuilder` detecta cuándo un coche cruza
la meta (sube `laps_completed`) y genera la fila de esa vuelta con las mismas columnas
que los CSV oficiales (…_Analysis_….CSV), de modo que la app los lee sin cambios:

    CROSSING_FINISH_LINE_IN_PIT = "B"  si el coche entró al pit lane en esta vuelta y
                                       sigue dentro al cruzar la meta (vuelta de entrada)
    PIT_TIME                           en la vuelta en la que SALE del pit lane:
                                       salida − entrada (incluye tiempo en el garaje)
    FLAG_AT_FL                         bandera de la sesión al cruzar la meta (GF, FCY, SC, FF, RF)
    S1 / S2 / S3                       S2 y S3 se obtienen de los parciales acumulados
    ELAPSED                            suma de los tiempos de vuelta del coche
    DRIVER_NUMBER                      orden de aparición del piloto en ese coche (1, 2, 3...)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class SessionState:
    time: float  # s de sesión según el juego
    session: str  # "RACE", "PRACTICE1", "QUALIFY"...
    track: str
    flag: str  # "GF", "FCY", "SC", "RF", "FF"
    track_length: float | None = None  # m


@dataclass
class CarState:
    slot: str  # identificador único del coche en la sesión
    number: str
    team: str
    vehicle: str
    car_class: str
    driver: str
    laps_completed: int
    last_lap: float | None  # s; None si no hay tiempo válido
    last_s1: float | None  # s, sector 1 de la última vuelta
    last_s2_cumulative: float | None  # s, S1 + S2 de la última vuelta
    in_pits: bool  # en el pit lane (o en el garaje)
    speed: float | None = None  # m/s


@dataclass
class Snapshot:
    session: SessionState
    cars: list[CarState]
    wall_clock: datetime = field(default_factory=datetime.now)


COLUMNS = [
    "NUMBER", "DRIVER_NUMBER", "LAP_NUMBER", "LAP_TIME", "LAP_IMPROVEMENT",
    "CROSSING_FINISH_LINE_IN_PIT", "S1", "S1_IMPROVEMENT", "S2", "S2_IMPROVEMENT", "S3",
    "S3_IMPROVEMENT", "KPH", "ELAPSED", "HOUR", "S1_LARGE", "S2_LARGE", "S3_LARGE",
    "TOP_SPEED", "DRIVER_NAME", "PIT_TIME", "CLASS", "GROUP", "TEAM", "MANUFACTURER",
    "FLAG_AT_FL", "S1_SECONDS", "S2_SECONDS", "S3_SECONDS",
]


def fmt_time(seconds: float | None) -> str:
    """92.84 -> '1:32.840' · 3692.84 -> '1:01:32.840' · None -> ''."""
    if seconds is None or seconds < 0:
        return ""
    ms = round(seconds * 1000)
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs = f"{rest / 1000:06.3f}"
    return f"{hours}:{minutes:02d}:{secs}" if hours else f"{minutes}:{secs}"


def _valid(value: float | None, low: float = 0.5) -> float | None:
    return value if value is not None and value > low else None


@dataclass
class _Car:
    laps: int  # vueltas completadas vistas por última vez
    last_cross_time: float | None  # s de sesión del último cruce de meta
    elapsed: float = 0.0
    drivers: list[str] = field(default_factory=list)
    pit_entry: float | None = None  # s de sesión al entrar al pit lane
    entered_this_lap: bool = False
    pending_pit: float | None = None  # duración de una salida en esta vuelta
    top_speed: float = 0.0  # m/s en esta vuelta (muestreado)
    was_in_pits: bool = False
    # piloto que conduce la vuelta: el más visto en pista (no en boxes), porque el
    # relevo puede aparecer justo al cruzar la meta en el pit lane
    lap_drivers: dict[str, int] = field(default_factory=dict)


class LapBuilder:
    def __init__(self, known_laps: dict[str, int] | None = None):
        # vueltas ya escritas por coche (al reanudar tras un corte): no se repiten
        self.known_laps = dict(known_laps or {})
        self.cars: dict[str, _Car] = {}
        self.missed: dict[str, int] = {}  # vueltas perdidas por coche (colector parado)

    def update(self, snap: Snapshot) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        now = snap.session.time
        for car in snap.cars:
            state = self.cars.get(car.slot)
            if state is None:
                # primera vez que se ve el coche: no se sabe cuándo empezó su vuelta actual
                state = _Car(laps=car.laps_completed, last_cross_time=None, was_in_pits=car.in_pits)
                if car.in_pits:
                    state.pit_entry = now
                self.cars[car.slot] = state
                if car.driver and car.driver not in state.drivers:
                    state.drivers.append(car.driver)
                continue

            if car.driver and not car.in_pits:
                state.lap_drivers[car.driver] = state.lap_drivers.get(car.driver, 0) + 1
            if car.speed is not None:
                state.top_speed = max(state.top_speed, car.speed)

            # pit lane: entrada y salida
            if car.in_pits and not state.was_in_pits:
                state.pit_entry = now
                state.entered_this_lap = True
            elif not car.in_pits and state.was_in_pits:
                if state.pit_entry is not None:
                    state.pending_pit = (state.pending_pit or 0.0) + (now - state.pit_entry)
                state.pit_entry = None
            state.was_in_pits = car.in_pits

            if car.laps_completed > state.laps:
                skipped = car.laps_completed - state.laps - 1
                if skipped > 0:
                    self.missed[car.number] = self.missed.get(car.number, 0) + skipped
                rows.append(self._lap_row(car, state, snap))
                state.laps = car.laps_completed
                state.last_cross_time = now
                state.entered_this_lap = car.in_pits  # sigue en boxes: la vuelta de salida empieza dentro
                state.pending_pit = None
                state.top_speed = 0.0
                state.lap_drivers = {}
            elif car.laps_completed < state.laps:
                state.laps = car.laps_completed  # reinicio de sesión o de vueltas
        return [r for r in rows if r]

    def _lap_row(self, car: CarState, state: _Car, snap: Snapshot) -> dict[str, str]:
        lap_number = car.laps_completed
        if lap_number <= self.known_laps.get(car.number, 0):
            return {}
        crossing_delta = (
            snap.session.time - state.last_cross_time if state.last_cross_time is not None else None
        )
        lap = _valid(car.last_lap) or _valid(crossing_delta)
        s1 = _valid(car.last_s1, 0.1)
        s2c = _valid(car.last_s2_cumulative, 0.1)
        s2 = s2c - s1 if s1 is not None and s2c is not None and s2c > s1 else None
        s3 = lap - s2c if lap is not None and s2c is not None and lap > s2c else None
        if lap is not None:
            state.elapsed += lap
        in_lap = car.in_pits and state.entered_this_lap
        kph = (
            snap.session.track_length / lap * 3.6
            if snap.session.track_length and lap else None
        )
        driver = max(state.lap_drivers, key=state.lap_drivers.get) if state.lap_drivers else car.driver
        if driver and driver not in state.drivers:
            state.drivers.append(driver)
        driver_number = state.drivers.index(driver) + 1 if driver in state.drivers else 1
        return {
            "NUMBER": car.number,
            "DRIVER_NUMBER": str(driver_number),
            "LAP_NUMBER": str(lap_number),
            "LAP_TIME": fmt_time(lap),
            "LAP_IMPROVEMENT": "0",
            "CROSSING_FINISH_LINE_IN_PIT": "B" if in_lap else "",
            "S1": fmt_time(s1),
            "S1_IMPROVEMENT": "0",
            "S2": fmt_time(s2),
            "S2_IMPROVEMENT": "0",
            "S3": fmt_time(s3),
            "S3_IMPROVEMENT": "0",
            "KPH": f"{kph:.1f}" if kph else "",
            "ELAPSED": fmt_time(state.elapsed) if state.elapsed else "",
            "HOUR": snap.wall_clock.strftime("%H:%M:%S.") + f"{snap.wall_clock.microsecond // 1000:03d}",
            "S1_LARGE": fmt_time(s1),
            "S2_LARGE": fmt_time(s2),
            "S3_LARGE": fmt_time(s3),
            "TOP_SPEED": f"{state.top_speed * 3.6:.1f}" if state.top_speed else "",
            "DRIVER_NAME": driver,
            "PIT_TIME": fmt_time(state.pending_pit) if state.pending_pit else "",
            "CLASS": car.car_class,
            "GROUP": "",
            "TEAM": car.team,
            "MANUFACTURER": car.vehicle,
            "FLAG_AT_FL": snap.session.flag,
            "S1_SECONDS": f"{s1:.3f}" if s1 is not None else "",
            "S2_SECONDS": f"{s2:.3f}" if s2 is not None else "",
            "S3_SECONDS": f"{s3:.3f}" if s3 is not None else "",
        }
