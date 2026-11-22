"""Colector en vivo de Le Mans Ultimate -> CSV en formato Al Kamel para RaceStrategy.

    python lmu_collector.py                    # LMU en este PC (http://localhost:6397)
    python lmu_collector.py --url http://192.168.1.20:6397   # LMU en otro PC de la red
    python lmu_collector.py --probe            # guarda lo que devuelve LMU y sale (para revisar)
    python lmu_collector.py --simulate         # carrera inventada, sin el juego (para probar)
    python lmu_collector.py --replay grabacion.jsonl.gz

Escribe en backend/data/raw/LMU/<fecha> <circuito>/<NN>_Analysis_<sesión>.CSV: la app lo
ve como cualquier otra sesión (recarga la página para ver las vueltas nuevas). Cada vuelta
se guarda al momento: si el colector se cierra, se vuelve a abrir y sigue sin repetir.
Mientras el juego no responde, espera y reintenta.
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

from lap_builder import LapBuilder, Snapshot
from sources import LmuRestSource, ReplaySource, SimulatedSource
from writer import AlKamelWriter

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "backend" / "data" / "raw" / "LMU"
LOGS = ROOT / "logs"


def safe(text: str) -> str:
    return re.sub(r"[^\w\- ()]+", "", text).strip() or "session"


def session_file(snap: Snapshot, started: datetime, out_dir: Path) -> Path:
    folder = out_dir / f"{started:%Y-%m-%d} {safe(snap.session.track)}"
    name = f"{started:%H%M}_Analysis_{safe(snap.session.session.title())}.CSV"
    return folder / name


def probe(url: str) -> int:
    source = LmuRestSource(url)
    raw = source.raw()
    if raw is None:
        print(f"No responde {url}: {source.last_error}")
        print("¿Está LMU abierto y dentro de una sesión? ¿Es el puerto correcto?")
        return 1
    LOGS.mkdir(exist_ok=True)
    out = LOGS / f"lmu-probe-{datetime.now():%Y%m%d-%H%M%S}.json"
    out.write_text(json.dumps({"sessionInfo": raw[0], "standings": raw[1]}, indent=2), encoding="utf-8")
    snap = Snapshot(*_mapped(raw))
    print(f"Respuesta guardada en {out}")
    print(f"Sesión: {snap.session.session} · {snap.session.track} · bandera {snap.session.flag} · t={snap.session.time:.1f}s")
    for car in snap.cars[:10]:
        print(f"  #{car.number:>4} {car.car_class:<9} {car.driver:<22} vueltas={car.laps_completed} "
              f"última={car.last_lap} s1={car.last_s1} s2acum={car.last_s2_cumulative} boxes={car.in_pits}")
    print("Comprueba que número, clase, piloto, vueltas y tiempos tienen sentido.")
    return 0


def _mapped(raw):
    from sources import map_rest
    snap = map_rest(*raw)
    return snap.session, snap.cars


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--url", default="http://localhost:6397", help="API de LMU (por defecto este PC)")
    parser.add_argument("--interval", type=float, default=0.5, help="segundos entre lecturas")
    parser.add_argument("--out", type=Path, default=DATA_DIR, help="carpeta de salida")
    parser.add_argument("--probe", action="store_true", help="guarda una respuesta de LMU y sale")
    parser.add_argument("--record", action="store_true", help="graba también los datos en bruto (logs/, .jsonl.gz)")
    parser.add_argument("--simulate", action="store_true", help="carrera inventada (sin el juego)")
    parser.add_argument("--speed", type=float, default=20.0, help="velocidad de la simulación (x tiempo real)")
    parser.add_argument("--replay", type=Path, help="reproduce una grabación .jsonl.gz")
    args = parser.parse_args()

    if args.probe:
        return probe(args.url)

    if args.simulate:
        source = SimulatedSource(speed=args.speed)
        label = f"simulación ×{args.speed:g}"
    elif args.replay:
        source = ReplaySource(args.replay)
        label = f"grabación {args.replay.name}"
    else:
        record = None
        if args.record:
            LOGS.mkdir(exist_ok=True)
            record = LOGS / f"lmu-raw-{datetime.now():%Y%m%d-%H%M%S}.jsonl.gz"
        source = LmuRestSource(args.url, record=record)
        label = f"LMU en {args.url}" + (f" (grabando en {record})" if record else "")

    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    print(f"RaceStrategy · colector LMU · {label}")
    print("Ctrl+C (o cerrar esta ventana) para parar. Las vueltas ya guardadas no se pierden.\n")

    writer: AlKamelWriter | None = None
    builder: LapBuilder | None = None
    session_key = None
    last_time = -1.0
    last_status = 0.0
    waiting_since: float | None = None
    started = datetime.now()

    while not stop:
        snap = source.read()
        if snap is None:
            if isinstance(source, ReplaySource) and source.finished:
                break
            if waiting_since is None:
                waiting_since = time.monotonic()
                print(f"Esperando a LMU… ({getattr(source, 'last_error', '')})")
            time.sleep(2.0)
            continue
        if waiting_since is not None:
            print("LMU conectado.")
            waiting_since = None

        # sesión nueva: otro tipo de sesión, otro circuito o el reloj vuelve atrás
        key = (snap.session.session, snap.session.track)
        if key != session_key or snap.session.time + 5 < last_time:
            if writer:
                writer.close()
            started = datetime.now() if not isinstance(source, ReplaySource) else snap.wall_clock
            path = session_file(snap, started, args.out)
            writer = AlKamelWriter(path)
            builder = LapBuilder(known_laps=writer.known_laps)
            session_key = key
            print(f"Sesión {snap.session.session} · {snap.session.track} -> {path}")
        last_time = snap.session.time

        rows = builder.update(snap)
        writer.write(rows)
        for row in rows:
            flag = "" if row["FLAG_AT_FL"] == "GF" else f" [{row['FLAG_AT_FL']}]"
            pit = " IN" if row["CROSSING_FINISH_LINE_IN_PIT"] else (" OUT " + row["PIT_TIME"] if row["PIT_TIME"] else "")
            print(f"  #{row['NUMBER']:>4} v{row['LAP_NUMBER']:>4}  {row['LAP_TIME']:>10}  {row['DRIVER_NAME']}{pit}{flag}")

        if time.monotonic() - last_status > 60:
            last_status = time.monotonic()
            missed = sum(builder.missed.values())
            print(f"[{datetime.now():%H:%M:%S}] {len(snap.cars)} coches · {writer.rows} vueltas guardadas"
                  + (f" · {missed} vueltas perdidas (colector parado o lecturas muy lentas)" if missed else ""))

        if not isinstance(source, ReplaySource):
            time.sleep(args.interval)

    if writer:
        writer.close()
        print(f"\nGuardado: {writer.path} ({writer.rows} vueltas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
