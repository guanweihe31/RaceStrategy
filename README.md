# WEC Strategy

Análisis del ritmo por vuelta en carreras de resistencia (WEC, LMP2, LMGT3).

## Quick start (no coding needed)

1. **Start:** double-click **`Start RaceStrategy.bat`** (or the *RaceStrategy* shortcut on
   the desktop). The first time it sets everything up by itself (a few minutes, needs
   internet); after that it starts in seconds and opens the app in your browser.
2. **Stop:** press **Enter** in the black window, or double-click **`Stop RaceStrategy.bat`**.
3. **Your timing files** (Al Kamel `..._Analysis_....CSV`) go in `backend\data\raw\`, one
   folder per event, e.g. `backend\data\raw\WEC\2026\Le Mans\`. Refresh the page after
   adding files. Name race files with "Race" in them to get the race-only charts.
4. **Getting your teammate's latest version:** install
   [GitHub Desktop](https://desktop.github.com/), sign in, *File → Add local repository* →
   this folder, then click **Fetch origin → Pull origin**. Start the app again afterwards:
   the launcher installs anything new automatically.
5. **Something went wrong?** Send a screenshot of the black window plus the files in the
   `logs` folder to your teammate.
6. **Choosing files:** *Elegir archivos…* lists every file in the data folder with its
   type. Tick one or several lap files (*Vueltas*) to analyse them together. Hourly
   classification files (`…_Classification_Race_Hour N.CSV`) have their own view:
   *Clasificación por horas*.
7. **Le Mans Ultimate live:** double-click `Start LMU Collector.bat` before the session;
   see [collector/README.md](collector/README.md) (not yet checked against the real game).

Only Python 3.10+ must be installed on the PC (python.org, tick *"Add python.exe to
PATH"*); the launcher downloads its own copy of Node.js into `tools\`.

```
wec-strategy/
├── backend/                  Python: importar, analizar y servir los datos
│   ├── src/                  importer, laps, metrics, api, main, config
│   ├── tests/                pruebas
│   ├── parked/               stints, boxes y degradación (aparcados)
│   ├── data/raw/WEC/2026/Barcelona/   CSV/Excel originales
│   └── requirements.txt
└── frontend/                 React + TypeScript + Vite
    ├── src/                  App.tsx, api.ts, index.css, main.tsx
    └── package.json
```

El frontend solo habla con el backend por HTTP: cada carpeta se puede
ejecutar, probar y desplegar por separado.

## Arranque (dos terminales)

```bash
# 1) Backend  ->  http://localhost:8000  (docs en /docs)
cd backend
pip install -r requirements.txt
cd src && uvicorn api:app --reload --port 8000

# 2) Frontend  ->  http://localhost:5173
cd frontend
npm install
npm run dev
```

- Coloca los CSV/Excel en `backend/data/raw/WEC/2026/Barcelona/`
  (u otra carpeta: `WEC_DATA_DIR=/ruta uvicorn api:app --port 8000`).
- URL del backend distinta: copia `frontend/.env.example` a `frontend/.env`.
- Pruebas del backend: `cd backend && python -m pytest tests`
- Comprobación de tipos del frontend: `cd frontend && npm run check`
- Informe por consola sin interfaz: `python backend/src/main.py archivo.CSV --car 007`

## Endpoints

| Ruta | Devuelve |
|---|---|
| `GET /api/sessions` | sesiones disponibles y ajustes (separador de milésimas, umbral) |
| `GET /api/sessions/{sesión}/overview` | resumen de la sesión y de cada categoría |
| `GET /api/sessions/{sesión}/categories/{cat}?slow=107` | mejores tiempos, clasificaciones (vuelta, S1, S2, S3), 4 coches más rápidos, lista de coches |
| `GET /api/sessions/{sesión}/cars/{número}?slow=107` | KPIs por piloto y todas las vueltas del coche con su estado |
