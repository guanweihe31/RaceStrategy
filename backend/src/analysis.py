"""Análisis de carrera sobre CSV de Al Kamel (WEC/ELMS).

Parte de los datos de `importer.import_data` (tiempos ya en segundos) y añade,
vuelta a vuelta, columnas en minúsculas (las que viajan tal cual en la API):

    is_in_lap        CROSSING_FINISH_LINE_IN_PIT == 'B'
    is_out_lap       PIT_TIME no vacío
    is_neutralized   FLAG_AT_FL distinto de 'GF'
    stint, stint_lap stint por coche: cambia con DRIVER_NUMBER o tras una parada
    traffic_loss     s perdidos por tráfico (picos de sector > umbral sobre la
                     mediana móvil de 5 vueltas del piloto)
    is_clean_air     vuelta verde, sin boxes y sin tráfico
    gap_to_reference ELAPSED del coche - ELAPSED del coche de referencia en la
                     misma vuelta (positivo = por detrás)

y resúmenes por stint (pendiente de degradación en aire limpio) y por piloto.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from config import (
    GREEN_FLAG, MIN_CLEAN_LAPS_FOR_SLOPE, TOP_N_LAPS, TRAFFIC_MIN_PERIODS,
    TRAFFIC_THRESHOLD, TRAFFIC_WINDOW,
)

SECTORS = ("S1", "S2", "S3")
SECTOR_SECONDS = [f"{s}_SECONDS" for s in SECTORS]
CAR_DRIVER = ["NUMBER", "DRIVER_NUMBER"]


def _text(df: pd.DataFrame, name: str) -> pd.Series:
    """Columna como texto sin espacios; todo NA si no existe."""
    if name not in df.columns:
        return pd.Series(pd.NA, index=df.index, dtype="string")
    return df[name].astype("string").str.strip().replace("", pd.NA)


def _numeric(df: pd.DataFrame, name: str) -> pd.Series:
    if name not in df.columns:
        return pd.Series(np.nan, index=df.index, dtype=float)
    return pd.to_numeric(df[name], errors="coerce").astype(float)


# ---------------------------------------------------------------------------
# 1-2. Estado de cada vuelta
# ---------------------------------------------------------------------------
def flag_laps(df: pd.DataFrame) -> pd.DataFrame:
    """Añade is_in_lap, is_out_lap, is_neutralized e is_green_racing.

    is_green_racing = vuelta verde que no es de entrada ni de salida de boxes y
    tiene tiempo: la base para referencias de ritmo y tráfico.
    Si el archivo no trae FLAG_AT_FL (columna vacía, eliminada al importar),
    ninguna vuelta se considera neutralizada; una celda vacía sí lo es (estado
    desconocido = no fiable).
    """
    df = df.sort_values(["NUMBER", "LAP_NUMBER"]).reset_index(drop=True)

    in_lap = _text(df, "CROSSING_FINISH_LINE_IN_PIT").str.upper().eq("B").fillna(False)
    out_lap = _text(df, "PIT_TIME").notna()
    if "FLAG_AT_FL" in df.columns:
        neutralized = _text(df, "FLAG_AT_FL").str.upper().ne(GREEN_FLAG).fillna(True)
    else:
        neutralized = pd.Series(False, index=df.index)

    df["is_in_lap"] = in_lap.astype(bool)
    df["is_out_lap"] = out_lap.astype(bool)
    df["is_neutralized"] = neutralized.astype(bool)
    df["is_green_racing"] = (
        ~df["is_in_lap"] & ~df["is_out_lap"] & ~df["is_neutralized"]
        & df["LAP_TIME_SECONDS"].notna()
    )
    return df


# ---------------------------------------------------------------------------
# Stints (DRIVER_NUMBER + paradas)
# ---------------------------------------------------------------------------
def mark_race_stints(df: pd.DataFrame) -> pd.DataFrame:
    """Añade stint (1, 2, 3... por coche) y stint_lap (1 = primera vuelta del stint).

    Empieza un stint nuevo en la primera vuelta del coche, en la vuelta siguiente
    a una entrada a boxes, en toda vuelta con PIT_TIME y cuando cambia DRIVER_NUMBER.
    `df` debe venir de `flag_laps` (ordenado por coche y vuelta).
    """
    df = df.copy()
    car = df["NUMBER"]
    driver = _numeric(df, "DRIVER_NUMBER")
    previous_driver = driver.groupby(car).shift(1)
    driver_change = previous_driver.notna() & driver.notna() & previous_driver.ne(driver)
    after_in_lap = df["is_in_lap"].groupby(car).shift(1, fill_value=False).astype(bool)
    first_lap = df.groupby("NUMBER").cumcount().eq(0)

    new_stint = first_lap | after_in_lap | df["is_out_lap"] | driver_change
    df["stint"] = new_stint.astype(int).groupby(car).cumsum()
    df["stint_lap"] = df.groupby(["NUMBER", "stint"]).cumcount() + 1
    return df


# ---------------------------------------------------------------------------
# 4. Tráfico
# ---------------------------------------------------------------------------
def estimate_traffic(
    df: pd.DataFrame,
    window: int = TRAFFIC_WINDOW,
    threshold: float = TRAFFIC_THRESHOLD,
    min_periods: int = TRAFFIC_MIN_PERIODS,
) -> pd.DataFrame:
    """Añade <S>_REFERENCE (mediana móvil), traffic_loss e is_clean_air.

    Para cada piloto (coche + DRIVER_NUMBER) se toma la mediana móvil centrada de
    `window` vueltas de cada sector, solo sobre sus vueltas verdes sin boxes (las
    vueltas bajo bandera o de boxes deformarían la referencia). Un sector que
    supera esa mediana en más de `threshold` s se considera afectado por tráfico
    y su exceso completo se suma en traffic_loss. La mediana es robusta: un único
    pico dentro de la ventana no la mueve.

    traffic_loss es NaN en vueltas no comparables (bandera, boxes) o sin
    referencia suficiente (menos de `min_periods` vueltas en la ventana).
    """
    df = df.copy()
    eligible = df[df["is_green_racing"]]
    for column in SECTOR_SECONDS:
        df[column.replace("_SECONDS", "_REFERENCE")] = np.nan

    keys = [eligible["NUMBER"], _numeric(eligible, "DRIVER_NUMBER").fillna(-1)]
    for _, laps in eligible.groupby(keys, sort=False):
        laps = laps.sort_values("LAP_NUMBER")
        reference = (
            laps[SECTOR_SECONDS]
            .rolling(window, center=True, min_periods=min_periods)
            .median()
        )
        for column in SECTOR_SECONDS:
            df.loc[laps.index, column.replace("_SECONDS", "_REFERENCE")] = reference[column]

    references = df[[c.replace("_SECONDS", "_REFERENCE") for c in SECTOR_SECONDS]].to_numpy()
    sectors = df[SECTOR_SECONDS].to_numpy(dtype=float)
    excess = sectors - references
    spikes = np.where(excess > threshold, excess, 0.0)
    has_reference = ~np.isnan(references).any(axis=1) & ~np.isnan(sectors).any(axis=1)

    df["traffic_loss"] = np.where(has_reference, spikes.sum(axis=1), np.nan)
    df["is_clean_air"] = df["is_green_racing"] & df["traffic_loss"].eq(0)
    return df


# ---------------------------------------------------------------------------
# Todo junto
# ---------------------------------------------------------------------------
def analyse_laps(df: pd.DataFrame) -> pd.DataFrame:
    """flag_laps + mark_race_stints + estimate_traffic sobre una sesión importada."""
    return estimate_traffic(mark_race_stints(flag_laps(df)))


# ---------------------------------------------------------------------------
# 3. Degradación en aire limpio por stint
# ---------------------------------------------------------------------------
STINT_COLUMNS = [
    "NUMBER", "stint", "CLASS", "TEAM", "DRIVER_NUMBER", "DRIVER_NAME",
    "start_lap", "end_lap", "laps", "clean_laps", "slope", "intercept", "r2",
]


def clean_air_degradation(
    analysed: pd.DataFrame, min_laps: int = MIN_CLEAN_LAPS_FOR_SLOPE
) -> pd.DataFrame:
    """Una fila por stint con la pendiente (s/vuelta) del tiempo de vuelta frente a
    stint_lap, usando solo vueltas en aire limpio (is_clean_air).

    slope > 0 = el coche pierde ritmo. Es degradación neta: incluye la ganancia por
    consumo de combustible y la evolución de la pista. Los stints con menos de
    `min_laps` vueltas limpias se devuelven con slope/intercept/r2 = NaN.
    """
    if min_laps < 2:
        raise ValueError("min_laps debe ser al menos 2 para ajustar una recta.")

    rows = []
    for (number, stint), laps in analysed.groupby(["NUMBER", "stint"], sort=False):
        clean = laps[laps["is_clean_air"]]
        slope = intercept = r2 = np.nan
        if len(clean) >= min_laps and clean["stint_lap"].nunique() >= 2:
            x = clean["stint_lap"].to_numpy(dtype=float)
            y = clean["LAP_TIME_SECONDS"].to_numpy(dtype=float)
            slope, intercept = np.polyfit(x, y, 1)
            residual = ((y - (slope * x + intercept)) ** 2).sum()
            total = ((y - y.mean()) ** 2).sum()
            r2 = 1 - residual / total if total > 0 else np.nan
        first = laps.iloc[0]
        rows.append(
            {
                "NUMBER": number,
                "stint": int(stint),
                "CLASS": first.get("CLASS"),
                "TEAM": first.get("TEAM"),
                "DRIVER_NUMBER": first.get("DRIVER_NUMBER"),
                "DRIVER_NAME": first.get("DRIVER_NAME"),
                "start_lap": int(laps["LAP_NUMBER"].min()),
                "end_lap": int(laps["LAP_NUMBER"].max()),
                "laps": len(laps),
                "clean_laps": len(clean),
                "slope": slope,
                "intercept": intercept,
                "r2": r2,
            }
        )
    return pd.DataFrame(rows, columns=STINT_COLUMNS)


# ---------------------------------------------------------------------------
# 5. Diferencia con un coche de referencia y resumen por piloto
# ---------------------------------------------------------------------------
def default_reference(df: pd.DataFrame) -> str | None:
    """Líder de los datos recibidos: más vueltas y, a igualdad, menor ELAPSED final."""
    valid = df.dropna(subset=["ELAPSED_SECONDS"])
    if valid.empty:
        return None
    last = valid.sort_values("LAP_NUMBER").groupby("NUMBER").tail(1)
    leader = last.sort_values(["LAP_NUMBER", "ELAPSED_SECONDS"], ascending=[False, True])
    return str(leader["NUMBER"].iloc[0])


def gap_to_reference(analysed: pd.DataFrame, reference: str) -> pd.DataFrame:
    """Añade gap_to_reference: ELAPSED del coche - ELAPSED de `reference` en la misma
    vuelta. NaN si la referencia no completó esa vuelta. Lanza KeyError si la
    referencia no existe."""
    ref = analysed[analysed["NUMBER"] == reference]
    if ref.empty:
        raise KeyError(reference)
    ref_elapsed = ref.set_index("LAP_NUMBER")["ELAPSED_SECONDS"]
    df = analysed.copy()
    df["gap_to_reference"] = df["ELAPSED_SECONDS"] - df["LAP_NUMBER"].map(ref_elapsed)
    return df


DRIVER_COLUMNS = [
    "NUMBER", "CLASS", "TEAM", "DRIVER_NUMBER", "DRIVER_NAME", "laps", "green_laps",
    "best_lap", "top_n_average", "top_n_laps", "std_dev", "traffic_laps", "total_traffic_loss",
]


def driver_race_summary(analysed: pd.DataFrame, top_n: int = TOP_N_LAPS) -> pd.DataFrame:
    """Una fila por piloto de cada coche.

    best_lap: mejor vuelta de todas las suyas. top_n_average: media de sus `top_n`
    vueltas más rápidas en verde y sin boxes (top_n_laps dice cuántas había).
    std_dev: desviación típica de esas vueltas verdes (consistencia).
    total_traffic_loss: suma de traffic_loss; traffic_laps: vueltas con pérdida > 0.
    Ordenado por top_n_average (más rápido primero).
    """
    rows = []
    for (number, _), laps in analysed.groupby(
        [analysed["NUMBER"], _numeric(analysed, "DRIVER_NUMBER").fillna(-1)], sort=False
    ):
        green = laps.loc[laps["is_green_racing"], "LAP_TIME_SECONDS"].dropna()
        fastest = green.nsmallest(top_n)
        first = laps.iloc[0]
        rows.append(
            {
                "NUMBER": number,
                "CLASS": first.get("CLASS"),
                "TEAM": first.get("TEAM"),
                "DRIVER_NUMBER": first.get("DRIVER_NUMBER"),
                "DRIVER_NAME": first.get("DRIVER_NAME"),
                "laps": len(laps),
                "green_laps": len(green),
                "best_lap": laps["LAP_TIME_SECONDS"].min(),
                "top_n_average": fastest.mean() if len(fastest) else np.nan,
                "top_n_laps": len(fastest),
                "std_dev": green.std() if len(green) >= 2 else np.nan,
                "traffic_laps": int(laps["traffic_loss"].gt(0).sum()),
                "total_traffic_loss": float(laps["traffic_loss"].sum()),
            }
        )
    summary = pd.DataFrame(rows, columns=DRIVER_COLUMNS)
    return summary.sort_values(["top_n_average", "best_lap"], na_position="last").reset_index(drop=True)
