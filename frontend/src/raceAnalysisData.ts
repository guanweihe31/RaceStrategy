// Análisis de carrera: datos de /api/sessions/{id}/analysis/* (backend/src/analysis.py)
// y cálculos derivados en el cliente (estadísticas por stint, paradas, gaps).
//
// Si el backend no tiene esos endpoints (no arrancado o sin actualizar) se usan datos
// de ejemplo con exactamente los mismos campos, marcados con source = "mock".

import { ApiError, enc, encPath, get } from "./api"

// ---------------------------------------------------------------------------
// Tipos (snake_case, tal cual los devuelve el backend)
// ---------------------------------------------------------------------------
export type AnalysisLap = {
  lap: number
  car: string
  category: string
  team: string
  driver: string
  driver_number: number | null
  stint: number
  stint_lap: number
  lap_time: number | null
  lap_time_text: string
  s1: number | null
  s2: number | null
  s3: number | null
  s1_reference: number | null
  s2_reference: number | null
  s3_reference: number | null
  pit_time: number | null // PIT_TIME: tiempo en el pit lane, en la vuelta de salida
  elapsed: number | null // ELAPSED: tiempo de carrera al cruzar la meta
  flag: string // FLAG_AT_FL
  is_in_lap: boolean
  is_out_lap: boolean
  is_neutralized: boolean // FLAG_AT_FL != GF
  is_green_racing: boolean
  is_clean_air: boolean
  traffic_loss: number | null
  gap_to_reference: number | null
}

export type AnalysisStint = {
  car: string
  category: string
  team: string
  stint: number
  driver: string
  driver_number: number | null
  start_lap: number
  end_lap: number
  laps: number
  clean_laps: number
  slope: number | null // s/vuelta en aire limpio; null si hay pocas vueltas limpias
  intercept: number | null
  r2: number | null
}

export type AnalysisDriver = {
  car: string
  category: string
  team: string
  driver: string
  driver_number: number | null
  laps: number
  green_laps: number
  best_lap: number | null
  best_lap_text: string
  top_n_average: number | null
  top_n_average_text: string
  top_n_laps: number
  std_dev: number | null
  traffic_laps: number
  total_traffic_loss: number | null
}

export type AnalysisSettings = {
  traffic_window: number
  traffic_threshold: number
  min_clean_laps_for_slope: number
  top_n_laps: number
}

export type RaceAnalysis = {
  source: "api" | "mock"
  mockReason?: string
  reference: string | null // coche de referencia por defecto (líder de la categoría)
  settings: AnalysisSettings
  laps: AnalysisLap[]
  stints: AnalysisStint[]
  drivers: AnalysisDriver[]
}

const DEFAULT_SETTINGS: AnalysisSettings = {
  traffic_window: 5,
  traffic_threshold: 0.4,
  min_clean_laps_for_slope: 5,
  top_n_laps: 10,
}

// ---------------------------------------------------------------------------
// Carga con alternativa de ejemplo
// ---------------------------------------------------------------------------
type LapsResponse = { reference: string | null; settings: AnalysisSettings; laps: AnalysisLap[] }
type StintsResponse = { stints: AnalysisStint[] }
type DriversResponse = { drivers: AnalysisDriver[] }

// "No conectado": sin conexión o el endpoint no existe (FastAPI responde 404 "Not Found").
function notConnected(error: unknown): boolean {
  return error instanceof ApiError && (error.status === null || (error.status === 404 && error.message === "Not Found"))
}

export async function loadRaceAnalysis(session: string, category: string): Promise<RaceAnalysis> {
  const base = `/api/sessions/${encPath(session)}/analysis`
  const query = `?category=${enc(category)}`
  try {
    const [laps, stints, drivers] = await Promise.all([
      get<LapsResponse>(`${base}/laps${query}`),
      get<StintsResponse>(`${base}/stints${query}`),
      get<DriversResponse>(`${base}/drivers${query}`),
    ])
    return {
      source: "api",
      reference: laps.reference,
      settings: { ...DEFAULT_SETTINGS, ...laps.settings },
      laps: laps.laps,
      stints: stints.stints,
      drivers: drivers.drivers,
    }
  } catch (error) {
    if (!notConnected(error)) throw error
    return mockRaceAnalysis(category, (error as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------------
export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function std(values: number[]): number | null {
  if (values.length < 2) return null
  const m = mean(values)!
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1))
}

function linearFit(xs: number[], ys: number[]) {
  const mx = mean(xs)!
  const my = mean(ys)!
  let sxx = 0
  let sxy = 0
  xs.forEach((x, i) => {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (ys[i] - my)
  })
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const total = ys.reduce((acc, y) => acc + (y - my) ** 2, 0)
  const residual = ys.reduce((acc, y, i) => acc + (y - (intercept + slope * xs[i])) ** 2, 0)
  return { slope, intercept, r2: total > 0 ? 1 - residual / total : null }
}

const times = (laps: AnalysisLap[]) =>
  laps.flatMap((l) => (l.lap_time === null ? [] : [l.lap_time]))

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

// ---------------------------------------------------------------------------
// Estadísticas por stint (el backend da la pendiente; el resto se calcula aquí)
// ---------------------------------------------------------------------------
export type StintStats = {
  car: string
  team: string
  stint: number
  driver: string
  driverNumber: number | null
  startLap: number
  endLap: number
  laps: number
  greenLaps: number
  cleanLaps: number
  best: number | null
  topAverage: number | null
  topLaps: number
  stdDev: number | null
  traffic: number
  slope: number | null
  r2: number | null
}

export function stintStats(analysis: RaceAnalysis): StintStats[] {
  const { laps, stints, settings } = analysis
  const fitted = new Map(stints.map((s) => [`${s.car}|${s.stint}`, s]))
  return [...groupBy(laps, (l) => `${l.car}|${l.stint}`).entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => a.lap - b.lap)
    const green = times(sorted.filter((l) => l.is_green_racing))
    const top = [...green].sort((a, b) => a - b).slice(0, settings.top_n_laps)
    const clean = sorted.filter((l) => l.is_clean_air && l.lap_time !== null)
    let slope: number | null = null
    let r2: number | null = null
    const fromApi = fitted.get(key)
    if (fromApi) {
      slope = fromApi.slope
      r2 = fromApi.r2
    } else if (clean.length >= settings.min_clean_laps_for_slope) {
      const fit = linearFit(clean.map((l) => l.stint_lap), clean.map((l) => l.lap_time!))
      slope = fit.slope
      r2 = fit.r2
    }
    const all = times(sorted)
    return {
      car: sorted[0].car,
      team: sorted[0].team,
      stint: sorted[0].stint,
      driver: sorted[0].driver,
      driverNumber: sorted[0].driver_number,
      startLap: sorted[0].lap,
      endLap: sorted[sorted.length - 1].lap,
      laps: sorted.length,
      greenLaps: green.length,
      cleanLaps: clean.length,
      best: all.length ? Math.min(...all) : null,
      topAverage: mean(top),
      topLaps: top.length,
      stdDev: std(green),
      traffic: sorted.reduce((acc, l) => acc + (l.traffic_loss ?? 0), 0),
      slope,
      r2,
    }
  })
}

// ---------------------------------------------------------------------------
// Paradas en boxes: tiempo en el pit lane y pérdida neta
// ---------------------------------------------------------------------------
export type PitStopBreakdown = {
  index: number
  inLap: number | null
  outLap: number
  driverOut: string
  driverIn: string
  driverChange: boolean
  pitLane: number | null // PIT_TIME de la vuelta de salida
  inLapTime: number | null
  outLapTime: number | null
  referencePace: number | null // ritmo de referencia del coche antes de parar
  netLoss: number | null // (entrada + salida) - 2 × referencia
  underNeutralization: boolean
}

/** Paradas de un coche. Cada vuelta con PIT_TIME que no es la primera del coche es una
 * parada; la vuelta anterior es la de entrada si está marcada con 'B'.
 * Pérdida neta = tiempo de la vuelta de entrada + el de la de salida − 2 × ritmo de
 * referencia, siendo la referencia la mediana de las vueltas en aire limpio del stint
 * anterior (o, si no hay, de las vueltas verdes de todo el coche). */
export function pitStopBreakdown(carLaps: AnalysisLap[]): PitStopBreakdown[] {
  const laps = [...carLaps].sort((a, b) => a.lap - b.lap)
  const carPace = median(times(laps.filter((l) => l.is_green_racing)))
  const stops: PitStopBreakdown[] = []
  laps.forEach((out, i) => {
    if (i === 0 || !out.is_out_lap) return
    const previous = laps[i - 1]
    const inLap = previous.is_in_lap ? previous : null
    const stintBefore = laps.filter((l) => l.car === out.car && l.stint === previous.stint)
    const reference =
      median(times(stintBefore.filter((l) => l.is_clean_air))) ??
      median(times(stintBefore.filter((l) => l.is_green_racing))) ??
      carPace
    const inTime = inLap?.lap_time ?? null
    const outTime = out.lap_time
    stops.push({
      index: stops.length + 1,
      inLap: inLap?.lap ?? null,
      outLap: out.lap,
      driverOut: previous.driver,
      driverIn: out.driver,
      driverChange: previous.driver !== out.driver,
      pitLane: out.pit_time,
      inLapTime: inTime,
      outLapTime: outTime,
      referencePace: reference,
      netLoss:
        inTime !== null && outTime !== null && reference !== null
          ? inTime + outTime - 2 * reference
          : null,
      underNeutralization: Boolean(inLap?.is_neutralized || out.is_neutralized),
    })
  })
  return stops
}

// ---------------------------------------------------------------------------
// Gap a un coche de referencia (ELAPSED coche − ELAPSED referencia en la misma vuelta)
// ---------------------------------------------------------------------------
export function gapsTo(laps: AnalysisLap[], reference: string): Map<string, number | null> {
  const refElapsed = new Map(
    laps.filter((l) => l.car === reference).map((l) => [l.lap, l.elapsed] as const),
  )
  const out = new Map<string, number | null>()
  for (const l of laps) {
    const ref = refElapsed.get(l.lap)
    out.set(
      `${l.car}|${l.lap}`,
      l.elapsed === null || ref === undefined || ref === null ? null : l.elapsed - ref,
    )
  }
  return out
}

/** Coches por orden de llegada: más vueltas y, a igualdad, menor ELAPSED final. */
export function finishingOrder(laps: AnalysisLap[]): string[] {
  const last = new Map<string, AnalysisLap>()
  for (const l of laps) {
    if (l.elapsed === null) continue
    const current = last.get(l.car)
    if (!current || l.lap > current.lap) last.set(l.car, l)
  }
  return [...last.values()]
    .sort((a, b) => b.lap - a.lap || a.elapsed! - b.elapsed!)
    .map((l) => l.car)
}

/** Periodos neutralizados (FCY/SC...): vueltas en las que al menos la mitad de los
 * coches cruzaron la meta con FLAG_AT_FL distinto de GF. */
export function neutralizedPeriods(laps: AnalysisLap[]): { from: number; to: number; flag: string }[] {
  const byLap = groupBy(laps, (l) => String(l.lap))
  const flagged = [...byLap.entries()]
    .map(([lap, group]) => {
      const neutral = group.filter((l) => l.is_neutralized)
      const flags = groupBy(neutral, (l) => l.flag || "FCY")
      const top = [...flags.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? ""
      return { lap: Number(lap), on: neutral.length * 2 >= group.length, flag: top }
    })
    .filter((x) => x.on)
    .sort((a, b) => a.lap - b.lap)
  const periods: { from: number; to: number; flag: string }[] = []
  for (const x of flagged) {
    const last = periods[periods.length - 1]
    if (last && x.lap === last.to + 1) last.to = x.lap
    else periods.push({ from: x.lap, to: x.lap, flag: x.flag })
  }
  return periods
}

// ---------------------------------------------------------------------------
// Datos de ejemplo (deterministas) con los mismos campos que el backend
// ---------------------------------------------------------------------------
function random(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MOCK_TEAMS = [
  ["1", "Equipo ejemplo A"],
  ["2", "Equipo ejemplo B"],
  ["3", "Equipo ejemplo C"],
  ["4", "Equipo ejemplo D"],
  ["5", "Equipo ejemplo E"],
  ["6", "Equipo ejemplo F"],
]
const MOCK_DRIVERS = ["A. Driver", "B. Driver", "C. Driver"]

function fmt(seconds: number | null): string {
  if (seconds === null) return "–"
  const ms = Math.round(seconds * 1000)
  const m = Math.floor(ms / 60000)
  return `${String(m).padStart(2, "0")}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`
}

export function mockRaceAnalysis(category: string, reason = ""): RaceAnalysis {
  const rnd = random(23)
  const totalLaps = 62
  const fcy = new Set([24, 25, 26]) // periodo de Full Course Yellow
  const laps: AnalysisLap[] = []

  MOCK_TEAMS.forEach(([car, team], ci) => {
    const base = 98.2 + ci * 0.28
    // paradas: vuelta de entrada; el coche 50 aprovecha la FCY
    const stops = ci === 1 ? [15, 25, 45] : [16 + (ci % 2), 33 + ci, 49 + (ci % 3)]
    let elapsed = 0
    let stint = 1
    let stintLap = 0
    let driverIndex = 0
    for (let lap = 1; lap <= totalLaps; lap++) {
      const isOut = stops.includes(lap - 1)
      const isIn = stops.includes(lap)
      if (isOut) {
        stint += 1
        stintLap = 0
        driverIndex = (driverIndex + 1) % MOCK_DRIVERS.length
      }
      stintLap += 1
      const neutral = fcy.has(lap)
      const wear = (0.05 + 0.025 * ((ci + stint) % 3)) * stintLap
      const ref = [base * 0.29 + wear * 0.3, base * 0.4 + wear * 0.4, base * 0.31 + wear * 0.3]
      const sectors = ref.map((v) => v + (rnd() - 0.5) * 0.25)
      let traffic = 0
      if (!neutral && !isIn && !isOut && lap > 1 && rnd() < 0.12) {
        const sector = Math.floor(rnd() * 3)
        const spike = 0.5 + rnd() * 1.4
        sectors[sector] += spike
        traffic = spike
      }
      if (lap === 1) sectors[0] += 4 // salida
      if (neutral) sectors.forEach((_, i) => (sectors[i] += 9))
      if (isIn) sectors[2] += 11
      const pitTime = isOut ? 58 + rnd() * 6 + (driverIndex === 0 ? 0 : 4) : null
      if (isOut) sectors[0] += pitTime! - 12
      const lapTime = sectors.reduce((a, b) => a + b, 0)
      elapsed += lapTime
      const green = !neutral && !isIn && !isOut
      laps.push({
        lap,
        car,
        category,
        team,
        driver: MOCK_DRIVERS[driverIndex],
        driver_number: driverIndex + 1,
        stint,
        stint_lap: stintLap,
        lap_time: lapTime,
        lap_time_text: fmt(lapTime),
        s1: sectors[0],
        s2: sectors[1],
        s3: sectors[2],
        s1_reference: green ? ref[0] : null,
        s2_reference: green ? ref[1] : null,
        s3_reference: green ? ref[2] : null,
        pit_time: pitTime,
        elapsed,
        flag: neutral ? "FCY" : "GF",
        is_in_lap: isIn,
        is_out_lap: isOut,
        is_neutralized: neutral,
        is_green_racing: green,
        is_clean_air: green && traffic === 0 && lap > 1,
        traffic_loss: green ? traffic : null,
        gap_to_reference: null,
      })
    }
  })

  const reference = finishingOrder(laps)[0] ?? null
  if (reference) {
    const gaps = gapsTo(laps, reference)
    laps.forEach((l) => (l.gap_to_reference = gaps.get(`${l.car}|${l.lap}`) ?? null))
  }

  const partial: RaceAnalysis = {
    source: "mock",
    mockReason: reason,
    reference,
    settings: DEFAULT_SETTINGS,
    laps,
    stints: [],
    drivers: [],
  }
  const stats = stintStats(partial)
  partial.stints = stats.map((s) => ({
    car: s.car,
    category,
    team: s.team,
    stint: s.stint,
    driver: s.driver,
    driver_number: s.driverNumber,
    start_lap: s.startLap,
    end_lap: s.endLap,
    laps: s.laps,
    clean_laps: s.cleanLaps,
    slope: s.slope,
    intercept: null,
    r2: s.r2,
  }))
  partial.drivers = [...groupBy(laps, (l) => `${l.car}|${l.driver_number}`).values()].map((group) => {
    const green = times(group.filter((l) => l.is_green_racing))
    const top = [...green].sort((a, b) => a - b).slice(0, DEFAULT_SETTINGS.top_n_laps)
    const best = Math.min(...times(group))
    const topAverage = mean(top)
    return {
      car: group[0].car,
      category,
      team: group[0].team,
      driver: group[0].driver,
      driver_number: group[0].driver_number,
      laps: group.length,
      green_laps: green.length,
      best_lap: best,
      best_lap_text: fmt(best),
      top_n_average: topAverage,
      top_n_average_text: fmt(topAverage),
      top_n_laps: top.length,
      std_dev: std(green),
      traffic_laps: group.filter((l) => (l.traffic_loss ?? 0) > 0).length,
      total_traffic_loss: group.reduce((acc, l) => acc + (l.traffic_loss ?? 0), 0),
    }
  })
  return partial
}
