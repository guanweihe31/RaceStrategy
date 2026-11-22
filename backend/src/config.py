"""Constantes del análisis. Se ajustan aquí sin tocar la lógica."""

# Separador entre segundos y milésimas: '01:32.840'. Usar ":" para mm:ss:ddd.
MS_SEPARATOR = "."

# Una vuelta es "lenta" si supera este múltiplo de la mejor del coche.
SLOW_LAP_THRESHOLD = 1.07

# Valores de FLAG_AT_FL que significan "vuelta normal": GF = bandera verde, FF = bandera
# final. CUALQUIER otro valor (FCY, VSC, SC, RF...) es una vuelta bajo bandera.
NORMAL_FLAGS = {"GF", "FF", "CF", "GREEN"}

PACE_STATUS = "Vuelta de ritmo"

CATEGORY_ORDER = ["HYPERCAR", "LMP2", "LMGT3"]

# ---------------------------------------------------------------------------
# Datos y API
# ---------------------------------------------------------------------------
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Carpeta raíz de los datos. Cada subcarpeta con CSV/Excel es un "evento"
# (p. ej. WEC/2026/Barcelona o ALMS/paul-ricard) y cada archivo, una sesión.
# Se puede cambiar sin tocar código:
#   WEC_DATA_DIR=/otra/carpeta uvicorn api:app
DATA_DIR = Path(os.environ.get("WEC_DATA_DIR", PROJECT_ROOT / "data" / "raw"))

# Números con ceros a la izquierda conocidos, por equipo (TEAM tal cual en el CSV).
# Además de estos, se aprenden solos de los demás archivos del mismo evento; esta lista
# solo hace falta cuando un evento tiene únicamente archivos guardados con Excel.
PADDED_CAR_NUMBERS: dict[str, list[str]] = {
    "Aston Martin Thor Team": ["007", "009"],
}

CATEGORY_LABELS = {"HYPERCAR": "Hypercar", "LMP2": "LMP2", "LMGT3": "LMGT3"}

# Orígenes del frontend (Vite) autorizados a llamar a la API.
CORS_ORIGINS = os.environ.get(
    "WEC_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

# Mínimo de vueltas de ritmo en un stint para ajustar su tendencia (degradación).
MIN_PACE_LAPS_FOR_DEGRADATION = 5

# ---------------------------------------------------------------------------
# Análisis de carrera (analysis.py)
# ---------------------------------------------------------------------------
# Única bandera que cuenta como vuelta "verde": cualquier otro FLAG_AT_FL
# (FCY, SC, VSC, FF...) marca la vuelta como neutralizada.
GREEN_FLAG = "GF"

# Tráfico: ventana (vueltas) de la mediana móvil por sector de cada piloto y
# umbral (s) a partir del cual un sector más lento que esa mediana es tráfico.
TRAFFIC_WINDOW = 5
TRAFFIC_MIN_PERIODS = 3
TRAFFIC_THRESHOLD = 0.4

# Mínimo de vueltas limpias (verde, sin boxes, sin tráfico) en un stint para
# calcular su pendiente de degradación.
MIN_CLEAN_LAPS_FOR_SLOPE = 5

# Nº de vueltas más rápidas que entran en la media "top N" del resumen por piloto.
TOP_N_LAPS = 10