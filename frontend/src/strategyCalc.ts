// Cálculos de estrategia en carrera, evaluados "en la vuelta N" de un coche (para poder
// revivir la carrera vuelta a vuelta o, en vivo, usar la última vuelta):
//   - tiempo de conducción por piloto frente a las reglas (máximos y mínimos),
//   - ventana de parada por combustible,
//   - posición de cada coche en pista en ese instante y zona de reincorporación.
//
// Tiempo de carrera = ELAPSED (Al Kamel: desde la salida, mismo reloj para todos).

import { median, pitStopBreakdown, type AnalysisLap } from "./raceAnalysisData"

const H = 3600

// ---------------------------------------------------------------------------
// Reglas de tiempo de conducción
// ---------------------------------------------------------------------------
export type DriveRules = {
  maxTotalH: number | null // máximo total por piloto
  windowH: number | null // ventana deslizante...
  maxInWindowH: number | null // ...y máximo dentro de ella
}

// Valores orientativos: comprobar siempre el reglamento deportivo vigente.
export const RULE_PRESETS: Record<string, { label: string; rules: DriveRules }> = {
  lemans: { label: "24 h de Le Mans (máx. 14 h · 4 h en 6 h)", rules: { maxTotalH: 14, windowH: 6, maxInWindowH: 4 } },
  custom: { label: "Personalizado", rules: { maxTotalH: null, windowH: null, maxInWindowH: null } },
}

type Interval = { driver: string; start: number; end: number; stint: number }

/** Tramos conducidos por cada piloto hasta `now` (s de carrera). Con `includePitLane`
 * false, en la vuelta de salida se descuenta el tiempo en el pit lane (PIT_TIME). */
export function driveIntervals(carLaps: AnalysisLap[], now: number, includePitLane = true): Interval[] {
  const out: Interval[] = []
  for (const l of [...carLaps].sort((a, b) => a.lap - b.lap)) {
    if (l.elapsed === null || l.lap_time === null) continue
    let start = l.elapsed - l.lap_time
    if (!includePitLane && l.is_out_lap && l.pit_time) start += Math.min(l.pit_time, l.lap_time)
    const end = Math.min(l.elapsed, now)
    if (start >= now) break
    if (end <= start) continue
    const last = out[out.length - 1]
    if (last && last.driver === l.driver && last.stint === l.stint && Math.abs(last.end - start) < 1)
      last.end = end
    else out.push({ driver: l.driver, start, end, stint: l.stint })
  }
  return out
}

/** Máximo tiempo conducido dentro de cualquier ventana de `window` s. */
function maxInWindow(intervals: Interval[], window: number): number {
  let best = 0
  const candidates = intervals.flatMap((i) => [i.start, i.end - window])
  for (const from of candidates) {
    const to = from + window
    const total = intervals.reduce((acc, i) => acc + Math.max(0, Math.min(i.end, to) - Math.max(i.start, from)), 0)
    best = Math.max(best, total)
  }
  return best
}

export type DriverTime = {
  driver: string
  total: number // s
  stints: number
  longest: number // s, tramo continuo más largo
  windowMax: number | null // s, máximo en la ventana de las reglas
  minimum: number // s exigidos (0 = sin mínimo)
  needed: number // s que faltan para el mínimo
  status: "ok" | "warn" | "bad"
  notes: string[]
}

export function driverTimes(
  carLaps: AnalysisLap[],
  now: number,
  raceEnd: number,
  rules: DriveRules,
  minimumsH: Record<string, number>,
  includePitLane = true,
): { drivers: DriverTime[]; intervals: Interval[]; remaining: number; impossible: boolean } {
  const intervals = driveIntervals(carLaps, now, includePitLane)
  const names = [...new Set(carLaps.map((l) => l.driver))]
  const remaining = Math.max(0, raceEnd - now)
  const drivers = names.map((driver) => {
    const own = intervals.filter((i) => i.driver === driver)
    const total = own.reduce((acc, i) => acc + i.end - i.start, 0)
    const windowMax = rules.windowH ? maxInWindow(own, rules.windowH * H) : null
    const minimum = (minimumsH[driver] ?? 0) * H
    const needed = Math.max(0, minimum - total)
    const notes: string[] = []
    let status: DriverTime["status"] = "ok"
    const flag = (level: "warn" | "bad", note: string) => {
      notes.push(note)
      if (level === "bad" || status === "ok") status = level
    }
    if (rules.maxTotalH) {
      const max = rules.maxTotalH * H
      if (total > max) flag("bad", "supera el máximo total")
      else if (total > 0.9 * max) flag("warn", "cerca del máximo total")
    }
    if (rules.maxInWindowH && windowMax !== null) {
      const max = rules.maxInWindowH * H
      if (windowMax > max) flag("bad", `más de ${rules.maxInWindowH} h en ${rules.windowH} h`)
      else if (windowMax > 0.9 * max) flag("warn", `cerca de ${rules.maxInWindowH} h en ${rules.windowH} h`)
    }
    if (needed > 0) {
      if (needed > remaining) flag("bad", "ya no puede llegar al mínimo")
      else if (needed > 0.5 * remaining) flag("warn", "le falta mucho para el mínimo")
    }
    return {
      driver,
      total,
      stints: new Set(own.map((i) => i.stint)).size,
      longest: Math.max(0, ...own.map((i) => i.end - i.start)),
      windowMax,
      minimum,
      needed,
      status,
      notes,
    }
  })
  const impossible = drivers.reduce((acc, d) => acc + d.needed, 0) > remaining
  return { drivers, intervals, remaining, impossible }
}

// ---------------------------------------------------------------------------
// Ventana de parada
// ---------------------------------------------------------------------------
export type PitWindow = {
  lap: number // vuelta N evaluada
  lapsOnTank: number // vueltas desde la última salida de boxes
  fuelLeft: number // vueltas que quedan con el combustible actual
  lapTime: number // ritmo de referencia (mediana en verde)
  remainingLaps: number // vueltas que faltan hasta el final (estimadas)
  stopsNeeded: number // paradas mínimas desde ahora
  open: number | null // primera vuelta en la que parar no añade otra parada
  close: number | null // última vuelta posible por combustible
}

/** Vueltas por depósito observadas: el stint más largo ya terminado del coche. */
export function observedFuelLaps(carLaps: AnalysisLap[]): number | null {
  const stops = pitStopBreakdown(carLaps)
  const lengths: number[] = []
  let from = carLaps.length ? Math.min(...carLaps.map((l) => l.lap)) : 0
  for (const s of stops) {
    const end = s.inLap ?? s.outLap - 1
    lengths.push(end - from + 1)
    from = s.outLap
  }
  return lengths.length ? Math.max(...lengths) : null
}

export function pitWindow(carLaps: AnalysisLap[], lap: number, fuelLaps: number, raceEnd: number): PitWindow | null {
  const laps = [...carLaps].sort((a, b) => a.lap - b.lap)
  const current = laps.find((l) => l.lap === lap)
  if (!current || current.elapsed === null || fuelLaps < 1) return null
  const lastOut = [...laps].reverse().find((l) => l.lap <= lap && l.is_out_lap && l.lap > laps[0].lap)
  const lapsOnTank = lap - (lastOut?.lap ?? laps[0].lap) + 1
  const lapTime = median(laps.filter((l) => l.is_green_racing && l.lap_time !== null).map((l) => l.lap_time!)) ??
    current.lap_time ?? 0
  if (!lapTime) return null
  const remainingLaps = Math.max(0, Math.ceil((raceEnd - current.elapsed) / lapTime))
  const fuelLeft = Math.max(0, fuelLaps - lapsOnTank)
  if (remainingLaps <= fuelLeft)
    return { lap, lapsOnTank, fuelLeft, lapTime, remainingLaps, stopsNeeded: 0, open: null, close: null }
  const stopsNeeded = Math.ceil((remainingLaps - fuelLeft) / fuelLaps)
  return {
    lap,
    lapsOnTank,
    fuelLeft,
    lapTime,
    remainingLaps,
    stopsNeeded,
    open: lap + Math.max(0, remainingLaps - stopsNeeded * fuelLaps),
    close: lap + fuelLeft,
  }
}

// ---------------------------------------------------------------------------
// Posición en pista y zona de reincorporación
// ---------------------------------------------------------------------------
export type TrackCar = {
  car: string
  category: string
  team: string
  fraction: number // 0..1 desde la línea de meta en el sentido de la marcha
  inPits: boolean
  behind: number // s por detrás del coche estudiado en pista (0..vuelta)
}

/** Dónde está cada coche en pista en el instante `now`: fracción de la vuelta que
 * llevaba recorrida (interpolando entre sus pasos por meta). */
export function trackPositions(allLaps: AnalysisLap[], now: number, focus: string, refLap: number): TrackCar[] {
  const byCar = new Map<string, AnalysisLap[]>()
  for (const l of allLaps) byCar.set(l.car, [...(byCar.get(l.car) ?? []), l])
  const raw: Omit<TrackCar, "behind">[] = []
  byCar.forEach((laps, car) => {
    for (const l of laps) {
      if (l.elapsed === null || l.lap_time === null) continue
      const start = l.elapsed - l.lap_time
      if (now >= start && now < l.elapsed) {
        raw.push({
          car,
          category: l.category,
          team: l.team,
          fraction: (now - start) / l.lap_time,
          inPits: (l.is_in_lap && (now - start) / l.lap_time > 0.9) || (l.is_out_lap && (now - start) / l.lap_time < 0.25),
        })
        return
      }
    }
  })
  // el coche estudiado acaba de cruzar la meta en `now`: si no tiene vuelta siguiente
  // (última vuelta de los datos), se coloca en la línea
  if (!raw.some((c) => c.car === focus)) {
    const crossing = (byCar.get(focus) ?? []).find((l) => l.elapsed !== null && Math.abs(l.elapsed - now) < 0.01)
    if (crossing) raw.push({ car: focus, category: crossing.category, team: crossing.team, fraction: 0, inPits: crossing.is_in_lap })
  }
  const focusFraction = raw.find((c) => c.car === focus)?.fraction ?? 0
  return raw.map((c) => ({
    ...c,
    behind: ((((focusFraction - c.fraction) % 1) + 1) % 1) * refLap,
  }))
}

/** Pérdida neta de las paradas en verde del coche (para la zona roja). */
export function pitLossRange(carLaps: AnalysisLap[]): { min: number; max: number } | null {
  const losses = pitStopBreakdown(carLaps)
    .filter((s) => !s.underNeutralization && s.netLoss !== null && s.netLoss > 5 && s.netLoss < 400)
    .map((s) => s.netLoss!)
  if (!losses.length) return null
  return { min: Math.min(...losses), max: Math.max(...losses) }
}

export function formatHours(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`
}
