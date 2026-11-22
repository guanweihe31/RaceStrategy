"""Clasificaciones por horas de Al Kamel (p. ej. "03_Classification_Race_Hour 7.CSV").

Cada archivo es una foto de la clasificación al final de una hora de carrera: una fila
por coche con posición, vueltas, tiempo total, diferencias y vuelta rápida. Juntando
las de un evento se ve la evolución de la carrera hora a hora (sin datos por vuelta).
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

from importer import _read_csv, normalize_columns, time_to_seconds

HOUR_PATTERN = re.compile(r"hour[\s_-]*(\d+)", re.IGNORECASE)
LAPS_DOWN_PATTERN = re.compile(r"^(\d+)\s*(?:laps?|l|v)\b", re.IGNORECASE)
REQUIRED = {"POSITION", "NUMBER", "LAPS", "TOTAL_TIME"}


def race_time(value) -> float | None:
    """ "24:03'01.030" -> 86581.03 · "3'25.155" -> 205.155 · "10.913" -> 10.913."""
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return None
    text = str(value).strip().replace("'", ":")
    return time_to_seconds(text) if text else None


def gap_value(value) -> tuple[float | None, int]:
    """GAP_FIRST / GAP_PREVIOUS: (segundos, vueltas perdidas). "1 Lap" -> (None, 1)."""
    if value is None or (not isinstance(value, str) and pd.isna(value)):
        return None, 0
    text = str(value).strip()
    match = LAPS_DOWN_PATTERN.match(text)
    if match:
        return None, int(match.group(1))
    return race_time(text), 0


def hour_of(path: Path, fallback: int) -> int:
    match = HOUR_PATTERN.search(path.stem)
    return int(match.group(1)) if match else fallback


def load_classification(paths: list[Path]) -> pd.DataFrame:
    """Todas las horas juntas, con HOUR, CLASS_POSITION, tiempos en segundos y
    LEADER_DELTA (tiempo total − vueltas × ritmo medio del líder de su clase)."""
    frames = []
    for index, path in enumerate(sorted(paths, key=lambda p: hour_of(p, 0))):
        df = normalize_columns(_read_csv(path))
        df = df.dropna(axis=1, how="all")
        if not REQUIRED <= set(df.columns):
            continue
        for column in df.columns:
            df[column] = df[column].astype("string").str.strip()
        df["HOUR"] = hour_of(path, index + 1)
        frames.append(df)
    if not frames:
        raise ValueError("No hay archivos de clasificación válidos.")
    df = pd.concat(frames, ignore_index=True)
    df["NUMBER"] = df["NUMBER"].str.replace(r"\.0$", "", regex=True)
    if "CLASS" not in df.columns:
        df["CLASS"] = ""
    df["POSITION"] = pd.to_numeric(df["POSITION"], errors="coerce")
    df["LAPS"] = pd.to_numeric(df["LAPS"], errors="coerce")
    df["TOTAL_SECONDS"] = df["TOTAL_TIME"].map(race_time).astype(float)
    df["BEST_SECONDS"] = (
        df["FL_TIME"].map(race_time).astype(float) if "FL_TIME" in df.columns else np.nan
    )
    gaps = df["GAP_FIRST"].map(gap_value) if "GAP_FIRST" in df.columns else None
    df["GAP_SECONDS"] = [g[0] for g in gaps] if gaps is not None else np.nan
    df["LAPS_DOWN"] = [g[1] for g in gaps] if gaps is not None else 0

    df = df.sort_values(["HOUR", "POSITION"]).reset_index(drop=True)
    df["CLASS_POSITION"] = df.groupby(["HOUR", "CLASS"]).cumcount() + 1
    leaders = df[df["CLASS_POSITION"] == 1].set_index(["HOUR", "CLASS"])
    pace = (leaders["TOTAL_SECONDS"] / leaders["LAPS"]).rename("LEADER_PACE")
    df = df.join(pace, on=["HOUR", "CLASS"])
    df["LEADER_DELTA"] = df["TOTAL_SECONDS"] - df["LAPS"] * df["LEADER_PACE"]
    return df


def drivers_of(row: pd.Series) -> list[str]:
    names = []
    for i in range(1, 7):
        name = row.get(f"DRIVER_{i}")
        if isinstance(name, str) and name.strip() and name.strip() not in names:
            names.append(name.strip())
    return names
