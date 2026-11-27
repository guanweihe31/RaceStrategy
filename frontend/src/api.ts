import { useEffect, useRef, useState } from "react"

// URL del backend. Para cambiarla: VITE_API_URL=http://otro-host:8000 en un .env
const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? "http://localhost:8000"

// ---------------------------------------------------------------------------
// Tipos (reflejan exactamente las respuestas de src/api.py)
// ---------------------------------------------------------------------------
export type Metric = "lap" | "s1" | "s2" | "s3"

export type TimeValue = { seconds: number | null; text: string }

export type Settings = { msSeparator: string; slowThresholdPct: number }
// categories: las categorías que trae el archivo (null si no se pudo determinar)
// overall: la sesión virtual que junta todas las sesiones
// event: carpeta de datos a la que pertenece (p. ej. "ALMS/paul-ricard"); eventName: su nombre legible
export type SessionInfo = {
  id: string
  name: string
  overall: boolean
  event: string
  eventName: string
  categories: string[] | null
}
// Cualquier archivo de la carpeta de datos, con su tipo:
//   analysis = vuelta a vuelta (se analiza) · classification = foto de la clasificación
export type DataFile = {
  id: string
  name: string
  event: string
  eventName: string
  kind: "analysis" | "classification" | "unknown"
  categories: string[] | null
  sizeKb: number
}
export type ClassificationEvent = { event: string; eventName: string; files: number }
export type SessionsResponse = {
  sessions: SessionInfo[]
  files?: DataFile[] // (backends antiguos no lo envían)
  classifications?: ClassificationEvent[]
  settings: Settings
  dataDir: string
}

// Selección libre de archivos de vueltas: un id normal si es uno, si no "__sel__:id1|id2".
export const SELECTION_PREFIX = "__sel__:"
export function selectionId(ids: string[]): string {
  return ids.length === 1 ? ids[0] : SELECTION_PREFIX + ids.join("|")
}
export function selectionIds(session: string): string[] | null {
  return session.startsWith(SELECTION_PREFIX)
    ? session.slice(SELECTION_PREFIX.length).split("|").filter(Boolean)
    : null
}

// Clasificación por horas (/api/events/{evento}/classification)
export type ClassificationSnapshot = {
  hour: number
  position: number | null
  classPosition: number
  laps: number | null
  status: string
  totalTime: number | null
  gapFirst: string
  gapSeconds: number | null
  lapsDown: number
  leaderDelta: number | null // tiempo total − vueltas × ritmo medio del líder de su clase
  bestLap: TimeValue
  bestLapNumber: number | null
}
export type ClassificationCar = {
  number: string
  team: string
  vehicle: string
  category: string
  tyres: string
  drivers: string[]
  finalPosition: number | null
  snapshots: ClassificationSnapshot[]
}
export type ClassificationData = {
  event: string
  eventName: string
  hours: number[]
  categories: { id: string; label: string }[]
  notices: string[]
  cars: ClassificationCar[]
}

export type Best = TimeValue & {
  key: Metric
  label: string
  car: string
  team: string
  session: string
  driver: string
  lap: number
  clock: string
  elapsed: string
}

export type CategorySummary = {
  id: string
  label: string
  cars: number
  drivers: number
  laps: number
  bestLap: Best
}
export type Overview = {
  session: { id: string; name: string; event: string; eventName: string }
  overall: boolean
  sessionCount: number
  laps: number
  cars: number
  drivers: number
  clockStart: string
  clockEnd: string
  categories: CategorySummary[]
}

export type RankingRow = TimeValue & {
  position: number
  car: string
  team: string
  driver: string
  session: string
  gapText: string
  lap: number
  clock: string
}
export type CarPace = {
  car: string
  team: string
  laps: { lap: number; seconds: number | null; driver: string; session: string; sessionLap: number }[]
}
export type CarOption = {
  number: string
  team: string
  manufacturer: string
  drivers: string[]
}
export type CategoryData = {
  category: { id: string; label: string }
  counts: { laps: number; paceLaps: number; cars: number; drivers: number }
  bests: Best[]
  rankings: Record<Metric, RankingRow[]>
  pace: CarPace[]
  cars: CarOption[]
}

export type DriverRow = {
  name: string
  laps: number
  paceLaps: number
  best: TimeValue
  s1: TimeValue
  s2: TimeValue
  s3: TimeValue
  median: TimeValue
  mean: TimeValue // media de las vueltas de ritmo (sin boxes, banderas ni lentas)
  meanGap: TimeValue // diferencia de la media con la del piloto más rápido del coche
  medianGap: TimeValue
  deltaText: string
}
export type CarLap = TimeValue & {
  lap: number // en "todas las sesiones", vuelta acumulada del coche
  stint: number
  stintLap: number
  session: string
  sessionLap: number // vuelta dentro de su sesión
  driver: string
  s1: string
  s2: string
  s3: string
  clock: string
  status: string
  flag: string // bandera al cruzar la meta (FCY, VSC, SC, RF...); "" si fue una vuelta normal
  pit: "in" | "out" | "" // entrada o salida de boxes
  isPace: boolean
}
export type StintRow = {
  stint: number
  driver: string
  startLap: number
  endLap: number
  laps: number
  paceLaps: number
  best: TimeValue
  median: TimeValue
  // tiempo ≈ intercept + slope × (vuelta del stint); null si hay pocas vueltas de ritmo
  trend: { slope: number; intercept: number; r2: number | null } | null
}
export type PitStop = {
  fromLap: number // vuelta de entrada a boxes
  toLap: number // vuelta de salida
  driverOut: string // piloto que sale del coche
  driverIn: string // piloto que entra
  driverChange: boolean
  pit: TimeValue // tiempo en boxes
}
// Paradas de un mismo tipo: nº con tiempo registrado, media, mejor y peor.
export type PitGroup = { count: number; mean: TimeValue; best: TimeValue; worst: TimeValue }
export type PitSummary = { withChange: PitGroup; withoutChange: PitGroup }
export type CarData = {
  car: { number: string; team: string; manufacturer: string; category: string }
  counts: { laps: number; paceLaps: number }
  drivers: DriverRow[]
  stints: StintRow[]
  pitStops: PitStop[]
  pitSummary: PitSummary
  laps: CarLap[]
}

// ---------------------------------------------------------------------------
// Formato de tiempos (mismo criterio que format_lap_time de Python).
// El separador de milésimas lo manda el backend (config.MS_SEPARATOR).
// ---------------------------------------------------------------------------
let msSeparator = "."

export function setMsSeparator(separator: string) {
  msSeparator = separator
}

export function formatLapTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "–"
  const totalMs = Math.round(seconds * 1000)
  const minutes = Math.floor(totalMs / 60000)
  const rest = ((totalMs % 60000) / 1000).toFixed(3).padStart(6, "0")
  return `${String(minutes).padStart(2, "0")}:${rest.replace(".", msSeparator)}`
}

export function formatSeconds(seconds: number): string {
  return seconds.toFixed(3).replace(".", msSeparator)
}

export function formatSigned(seconds: number): string {
  const sign = seconds >= 0 ? "+" : "-"
  return `${sign}${Math.abs(seconds).toFixed(3).replace(".", msSeparator)}`
}

export function timeFormatLabel(): string {
  return `mm:ss${msSeparator}ddd`
}

// ---------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------
// Error de la API con el código HTTP (null si ni siquiera hubo conexión).
export class ApiError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
  }
}

export async function get<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`)
  } catch {
    throw new ApiError(
      `No se pudo conectar con el backend (${BASE}). ¿Está arrancado? Desde la carpeta src: uvicorn api:app --port 8000`,
      null,
    )
  }
  if (!response.ok) {
    let detail = `Error ${response.status}`
    try {
      const body = await response.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      // la respuesta no traía JSON: se deja el código de estado
    }
    throw new ApiError(detail, response.status)
  }
  return (await response.json()) as T
}

export const enc = encodeURIComponent
// El id de sesión es una ruta ("WEC/2026/Barcelona/FP1.CSV"): se codifica cada tramo.
export const encPath = (path: string) => path.split("/").map(enc).join("/")

export const api = {
  sessions: () => get<SessionsResponse>("/api/sessions"),
  classification: (event: string) =>
    get<ClassificationData>(`/api/events/${encPath(event)}/classification`),
  overview: (session: string) =>
    get<Overview>(`/api/sessions/${encPath(session)}/overview`),
  category: (session: string, category: string, slow: number) =>
    get<CategoryData>(
      `/api/sessions/${encPath(session)}/categories/${enc(category)}?slow=${slow}`,
    ),
  car: async (session: string, number: string, slow: number) => {
    const data = await get<CarData>(
      `/api/sessions/${encPath(session)}/cars/${enc(number)}?slow=${slow}`,
    )
    // Un backend sin reiniciar responde sin los campos nuevos y la pantalla se rompería.
    if (!data.pitSummary || !data.pitStops || data.drivers.some((d) => !d.meanGap || !d.mean)) {
      throw new Error(
        "El backend está desactualizado (faltan pitSummary, pitStops o meanGap). " +
          "Reinícialo y comprueba que api.py y metrics.py son los últimos.",
      )
    }
    return data
  },
}

// ---------------------------------------------------------------------------
// Hook: carga de datos con estado. `load = null` significa "todavía no".
// Al cambiar las dependencias se vacía el dato y se vuelve a pedir.
// ---------------------------------------------------------------------------
type State<T> = { data: T | null; error: string | null; loading: boolean }

// `refreshMs`: vuelve a pedir el dato cada X ms SIN vaciarlo mientras llega (modo en
// vivo: la pantalla no parpadea ni pierde el zoom). Un fallo puntual no borra el dato.
export function useApi<T>(
  load: (() => Promise<T>) | null,
  deps: unknown[],
  refreshMs: number | null = null,
): State<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    loading: load !== null,
  })
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!refreshMs) return
    let cancelled = false
    const timer = setInterval(() => {
      const current = loadRef.current
      if (!current) return
      current()
        .then((data) => {
          if (!cancelled) setState({ data, error: null, loading: false })
        })
        .catch(() => {})
    }, refreshMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshMs])

  useEffect(() => {
    if (!load) {
      setState({ data: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setState({ data: null, error: null, loading: true })
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false })
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ data: null, error: error.message, loading: false })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}