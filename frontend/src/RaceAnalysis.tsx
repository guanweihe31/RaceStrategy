// Vistas de análisis de carrera: traza de gaps, distancia de carrera frente al ganador,
// comparativa de pilotos/stints, paradas y calculadora de combustible.
// Los datos llegan de raceAnalysisData.ts (backend o, si no está conectado, de ejemplo).

import { useMemo, useState } from "react"
import { formatLapTime, formatSigned } from "./api"
import { carColor, gapTick, secs } from "./chartUtils"
import { FuelCalculator } from "./FuelCalculator"
import {
  finishingOrder,
  gapsTo,
  neutralizedPeriods,
  pitStopBreakdown,
  stintStats,
  type AnalysisLap,
  type RaceAnalysis,
} from "./raceAnalysisData"
import { TraceChart, type TraceBand, type TraceLine } from "./TraceChart"

const FCY_FILL = "rgba(255, 214, 10, 0.13)"
const PIT_FILL = "rgba(169, 188, 210, 0.16)"
const DEFAULT_VISIBLE = 8

type YRange = "auto" | "30" | "60" | "120"

function useLapsByCar(laps: AnalysisLap[]) {
  return useMemo(() => {
    const out = new Map<string, AnalysisLap[]>()
    for (const l of laps) {
      const list = out.get(l.car)
      if (list) list.push(l)
      else out.set(l.car, [l])
    }
    out.forEach((list) => list.sort((a, b) => a.lap - b.lap))
    return out
  }, [laps])
}

function fcyBands(laps: AnalysisLap[]): TraceBand[] {
  return neutralizedPeriods(laps).map((p) => ({
    from: p.from,
    to: p.to,
    fill: FCY_FILL,
    label: p.flag || "FCY",
    labelColor: "#FFD60A",
  }))
}

function pitBands(carLaps: AnalysisLap[]): TraceBand[] {
  return pitStopBreakdown(carLaps).map((s) => ({
    from: (s.inLap ?? s.outLap - 1) + 0.5,
    to: s.outLap - 0.5,
    fill: PIT_FILL,
    label: `P${s.index}`,
    labelColor: "#A9BCD2",
    bottom: true,
  }))
}

/** Selección de coches visibles con chips (por defecto los primeros + los fijos). */
function useCarPicker(order: string[], always: string[]) {
  const [picked, setPicked] = useState<string[] | null>(null)
  const defaults = [...new Set([...order.slice(0, DEFAULT_VISIBLE), ...always.filter(Boolean)])]
  const visible = (picked ?? defaults).filter((c) => order.includes(c))
  return {
    visible,
    toggle: (car: string) =>
      setPicked(visible.includes(car) ? visible.filter((c) => c !== car) : [...visible, car]),
    all: () => setPicked(order),
    top: () => setPicked(null),
  }
}

function CarChips({
  order,
  teams,
  picker,
  marked,
  markLabel,
}: {
  order: string[]
  teams: Map<string, string>
  picker: ReturnType<typeof useCarPicker>
  marked: string
  markLabel: string
}) {
  return (
    <div className="gap-chips" role="group" aria-label="Coches visibles">
      {order.map((car) => {
        const on = picker.visible.includes(car)
        return (
          <button
            key={car}
            type="button"
            className={`chip${on ? " on" : ""}${car === marked ? " ref" : ""}`}
            aria-pressed={on}
            onClick={() => picker.toggle(car)}
            title={teams.get(car)}
          >
            <i style={{ background: carColor(order, car) }} />#{car}
            {car === marked && <small>{markLabel}</small>}
          </button>
        )
      })}
      <button type="button" className="chip ghost" onClick={picker.all}>
        Todos
      </button>
      <button type="button" className="chip ghost" onClick={picker.top}>
        Top {DEFAULT_VISIBLE}
      </button>
    </div>
  )
}

function TraceLegend({ pitCar }: { pitCar: string | null }) {
  return (
    <div className="legend race-legend">
      <span>
        <svg width="18" height="12" aria-hidden="true">
          <rect width="18" height="12" fill={FCY_FILL} stroke="#FFD60A" strokeOpacity="0.4" />
        </svg>
        FCY / Safety Car (FLAG_AT_FL ≠ GF en la mayoría de coches)
      </span>
      {pitCar && (
        <span>
          <svg width="18" height="12" aria-hidden="true">
            <rect width="18" height="12" fill={PIT_FILL} stroke="#A9BCD2" strokeOpacity="0.4" />
          </svg>
          Paradas del #{pitCar}
        </span>
      )}
      <span>
        <svg width="18" height="12" aria-hidden="true">
          <circle cx="9" cy="6" r="3.5" fill="none" stroke="#E6EDF5" strokeWidth="1.6" />
        </svg>
        Vuelta de salida de boxes
      </span>
    </div>
  )
}

function RangeSelect({ value, onChange }: { value: YRange; onChange: (v: YRange) => void }) {
  return (
    <label className="car-select race-range">
      <span>RANGO Y</span>
      <select value={value} onChange={(event) => onChange(event.target.value as YRange)}>
        <option value="auto">Automático</option>
        <option value="30">± 30 s</option>
        <option value="60">± 60 s</option>
        <option value="120">± 120 s</option>
      </select>
    </label>
  )
}

function traceLines(
  order: string[],
  visible: string[],
  byCar: Map<string, AnalysisLap[]>,
  value: (l: AnalysisLap) => number | null,
  highlight: string | null,
): TraceLine[] {
  return visible.map((car) => {
    const points = (byCar.get(car) ?? []).flatMap((l) => {
      const y = value(l)
      return y === null ? [] : [{ x: l.lap, y, out: l.is_out_lap && l.lap > 1 }]
    })
    return {
      id: car,
      color: carColor(order, car),
      emphasis: car === highlight,
      dim: !!highlight && car !== highlight,
      points,
      rings: points.filter((p) => p.out),
    }
  })
}

// ---------------------------------------------------------------------------
// Traza de carrera: gap al coche de referencia vuelta a vuelta
// ---------------------------------------------------------------------------
function GapTrace({ analysis, focusCar }: { analysis: RaceAnalysis; focusCar: string | null }) {
  const { laps } = analysis
  const order = useMemo(() => finishingOrder(laps), [laps])
  const teams = useMemo(() => new Map(laps.map((l) => [l.car, l.team])), [laps])
  const byCar = useLapsByCar(laps)
  const [reference, setReference] = useState<string>(analysis.reference ?? order[0] ?? "")
  const [yRange, setYRange] = useState<YRange>("auto")

  const ref = order.includes(reference) ? reference : (order[0] ?? "")
  const highlight = focusCar && order.includes(focusCar) ? focusCar : null
  const picker = useCarPicker(order, [ref, highlight ?? ""])
  const gaps = useMemo(() => gapsTo(laps, ref), [laps, ref])
  const bands = useMemo(
    () => [...fcyBands(laps), ...(highlight ? pitBands(byCar.get(highlight) ?? []) : [])],
    [laps, byCar, highlight],
  )
  const lines = traceLines(order, picker.visible, byCar, (l) => gaps.get(`${l.car}|${l.lap}`) ?? null, highlight)
  const maxLap = Math.max(1, ...laps.map((l) => l.lap))
  const periods = useMemo(() => neutralizedPeriods(laps), [laps])

  const tooltip = (lap: number) => {
    const rows = picker.visible
      .map((car) => ({
        car,
        lap: byCar.get(car)?.find((l) => l.lap === lap),
        gap: gaps.get(`${car}|${lap}`) ?? null,
      }))
      .filter((r) => r.lap)
      .sort((a, b) => (a.gap ?? Infinity) - (b.gap ?? Infinity))
    if (!rows.length) return null
    const period = periods.find((p) => lap >= p.from && lap <= p.to)
    return (
      <>
        <b>
          Vuelta {lap}
          {period ? ` · ${period.flag || "FCY"}` : ""}
        </b>
        {rows.slice(0, 12).map(({ car, lap: l, gap }) => (
          <span key={car} className="gap-row">
            <i style={{ background: carColor(order, car) }} />#{car}
            <em>
              {car === ref ? "referencia" : gap === null ? "–" : `${formatSigned(gap)} s`}
              {l?.is_in_lap ? " · entra a boxes" : l?.is_out_lap ? " · sale de boxes" : ""}
            </em>
          </span>
        ))}
      </>
    )
  }

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Gap-to-Reference · traza de carrera</h2>
          <p>
            Diferencia acumulada (ELAPSED) con el coche de referencia al cruzar la meta en cada
            vuelta. Por encima de cero = por delante; por debajo = por detrás.
          </p>
        </div>
        <div className="race-tools">
          <label className="car-select">
            <span>REFERENCIA (LÍNEA CERO)</span>
            <select value={ref} onChange={(event) => setReference(event.target.value)}>
              {order.map((car) => (
                <option key={car} value={car}>
                  #{car} · {teams.get(car)}
                </option>
              ))}
            </select>
          </label>
          <RangeSelect value={yRange} onChange={setYRange} />
        </div>
      </div>
      <CarChips order={order} teams={teams} picker={picker} marked={ref} markLabel="REF" />
      <TraceLegend pitCar={highlight} />
      <TraceChart
        lines={lines}
        bands={bands}
        xMax={maxLap}
        resetKey={`${ref}|${yRange}`}
        ariaLabel={`Gap acumulado de cada coche respecto al #${ref}`}
        xLabel="vuelta de carrera"
        zeroLabel={`#${ref}`}
        formatTick={gapTick}
        limit={yRange === "auto" ? null : Number(yRange)}
        tooltip={tooltip}
      />
      <p className="chart-note">
        Gap = ELAPSED del coche − ELAPSED del #{ref} en la misma vuelta. Si la referencia aún no
        ha completado esa vuelta no hay punto. Las franjas amarillas marcan vueltas neutralizadas;
        las grises, las paradas del coche seleccionado arriba.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Distancia de carrera: cada coche de la clase frente al ganador
// ---------------------------------------------------------------------------
/** Gráfico de historia de carrera. El ganador marca un ritmo medio constante
 * (su ELAPSED final / sus vueltas); cada coche se dibuja como su ELAPSED − vueltas ×
 * ese ritmo. El ganador acaba en cero; una línea que baja pierde tiempo respecto al
 * ritmo medio ganador, una que sube lo gana. Las paradas y las FCY se ven como
 * escalones y mesetas. */
function RaceDistance({ analysis, focusCar }: { analysis: RaceAnalysis; focusCar: string | null }) {
  const { laps } = analysis
  const order = useMemo(() => finishingOrder(laps), [laps])
  const teams = useMemo(() => new Map(laps.map((l) => [l.car, l.team])), [laps])
  const byCar = useLapsByCar(laps)
  const [yRange, setYRange] = useState<YRange>("auto")
  const winner = order[0] ?? ""
  const highlight = focusCar && order.includes(focusCar) ? focusCar : null
  const picker = useCarPicker(order, [winner, highlight ?? ""])

  const winnerLaps = byCar.get(winner) ?? []
  const last = winnerLaps[winnerLaps.length - 1]
  const pace = last?.elapsed ? last.elapsed / last.lap : null
  const bands = useMemo(
    () => [...fcyBands(laps), ...(highlight ? pitBands(byCar.get(highlight) ?? []) : [])],
    [laps, byCar, highlight],
  )
  const delta = (l: AnalysisLap) => (pace === null || l.elapsed === null ? null : l.elapsed - l.lap * pace)
  const lines = traceLines(order, picker.visible, byCar, delta, highlight)
  const winnerAt = new Map(winnerLaps.map((l) => [l.lap, l.elapsed]))

  if (!winner || pace === null) return null

  const tooltip = (lap: number) => {
    const rows = picker.visible
      .map((car) => ({ car, lap: byCar.get(car)?.find((l) => l.lap === lap) }))
      .filter((r): r is { car: string; lap: AnalysisLap } => !!r.lap)
      .map((r) => ({ ...r, d: delta(r.lap) }))
      .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity))
    if (!rows.length) return null
    const w = winnerAt.get(lap)
    return (
      <>
        <b>
          Vuelta {lap} · {Math.round((lap / last.lap) * 100)} % de la distancia
        </b>
        {rows.slice(0, 12).map(({ car, lap: l, d }) => (
          <span key={car} className="gap-row">
            <i style={{ background: carColor(order, car) }} />#{car}
            <em>
              {d === null ? "–" : `${formatSigned(d)} s vs ritmo`}
              {car !== winner && w != null && l.elapsed !== null
                ? ` · ${formatSigned(l.elapsed - w)} s al ganador`
                : ""}
            </em>
          </span>
        ))}
      </>
    )
  }

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Distancia de carrera · frente al ganador</h2>
          <p>
            Ganador de la clase: #{winner} ({teams.get(winner)}), {last.lap} vueltas a un ritmo
            medio de {formatLapTime(pace)}. Cada coche: ELAPSED − vueltas × ese ritmo. El ganador
            termina en cero; bajar = perder tiempo frente al ritmo ganador.
          </p>
        </div>
        <div className="race-tools">
          <RangeSelect value={yRange} onChange={setYRange} />
        </div>
      </div>
      <CarChips order={order} teams={teams} picker={picker} marked={winner} markLabel="1º" />
      <TraceLegend pitCar={highlight} />
      <TraceChart
        lines={lines}
        bands={bands}
        xMax={last.lap}
        resetKey={`${winner}|${yRange}`}
        ariaLabel={`Diferencia de cada coche con el ritmo medio del ganador #${winner}`}
        xLabel="distancia (vueltas)"
        zeroLabel="ritmo ganador"
        formatTick={gapTick}
        limit={yRange === "auto" ? null : Number(yRange)}
        tooltip={tooltip}
      />
      <p className="chart-note">
        Los coches doblados terminan antes en el eje X (menos vueltas). La pendiente de cada tramo
        es su ritmo frente al medio del ganador: más plana = más rápido.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Comparativa de pilotos y stints
// ---------------------------------------------------------------------------
function slopeClass(slope: number | null): string {
  if (slope === null) return ""
  return slope > 0.05 ? "slope-up" : slope < -0.05 ? "slope-down" : "slope-flat"
}

function DriverStintTable({ analysis, focusCar }: { analysis: RaceAnalysis; focusCar: string | null }) {
  const order = useMemo(() => finishingOrder(analysis.laps), [analysis.laps])
  const stats = useMemo(() => stintStats(analysis), [analysis])
  const hasFocus = !!focusCar && order.includes(focusCar)
  const [scope, setScope] = useState<"car" | "all">(hasFocus ? "car" : "all")
  const cars = scope === "car" && hasFocus ? [focusCar!] : order
  const { top_n_laps: topN, min_clean_laps_for_slope: minClean } = analysis.settings

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Driver &amp; Stint Comparison</h2>
          <p>
            Por piloto (fila resumen) y por stint. Media top-{topN} y σ con vueltas verdes sin
            boxes; degradación con vueltas en aire limpio (mín. {minClean}).
          </p>
        </div>
        <div className="mode-switch" role="group" aria-label="Coches de la tabla">
          <button
            className={scope === "car" ? "active" : ""}
            aria-pressed={scope === "car"}
            disabled={!hasFocus}
            onClick={() => setScope("car")}
          >
            {hasFocus ? `Coche #${focusCar}` : "Coche"}
          </button>
          <button
            className={scope === "all" ? "active" : ""}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            Toda la categoría
          </button>
        </div>
      </div>
      <div className="table-scroll stint-table race-table">
        <table>
          <caption className="sr-only">Comparativa de pilotos y stints</caption>
          <thead>
            <tr>
              <th scope="col">Piloto / stint</th>
              <th scope="col">Vueltas</th>
              <th scope="col">Mejor vuelta</th>
              <th scope="col">Media top-{topN}</th>
              <th scope="col">Consistencia σ</th>
              <th scope="col">Degradación</th>
              <th scope="col">Tráfico</th>
            </tr>
          </thead>
          <tbody>
            {cars.map((car) => {
              const drivers = analysis.drivers.filter((d) => d.car === car)
              const carStints = stats.filter((s) => s.car === car).sort((a, b) => a.stint - b.stint)
              return [
                <tr key={`car-${car}`} className="car-row">
                  <th scope="rowgroup" colSpan={7}>
                    <i style={{ background: carColor(order, car) }} />#{car} · {carStints[0]?.team}
                  </th>
                </tr>,
                ...drivers.flatMap((d) => [
                  <tr key={`d-${car}-${d.driver_number}-${d.driver}`} className="driver-total">
                    <td>{d.driver}</td>
                    <td>
                      {d.laps} <small>({d.green_laps} verdes)</small>
                    </td>
                    <td>{d.best_lap_text}</td>
                    <td>
                      {d.top_n_average_text}
                      {d.top_n_laps < topN && <small> ({d.top_n_laps})</small>}
                    </td>
                    <td>{d.std_dev === null ? "–" : `${secs(d.std_dev)} s`}</td>
                    <td />
                    <td className={(d.total_traffic_loss ?? 0) > 0 ? "traffic-cell" : ""}>
                      {secs(d.total_traffic_loss, 1)} s <small>({d.traffic_laps} v.)</small>
                    </td>
                  </tr>,
                  ...carStints
                    .filter((s) => s.driverNumber === d.driver_number && s.driver === d.driver)
                    .map((s) => (
                      <tr key={`s-${car}-${s.stint}`} className="stint-row">
                        <td>
                          Stint {s.stint} <small>· v. {s.startLap}–{s.endLap}</small>
                        </td>
                        <td>
                          {s.laps} <small>({s.cleanLaps} limpias)</small>
                        </td>
                        <td>{formatLapTime(s.best)}</td>
                        <td>
                          {formatLapTime(s.topAverage)}
                          {s.topLaps > 0 && s.topLaps < topN && <small> ({s.topLaps})</small>}
                        </td>
                        <td>{s.stdDev === null ? "–" : `${secs(s.stdDev)} s`}</td>
                        <td
                          className={slopeClass(s.slope)}
                          title={
                            s.slope === null
                              ? `Menos de ${minClean} vueltas en aire limpio`
                              : s.r2 !== null
                                ? `R² ${s.r2.toFixed(2)}`
                                : undefined
                          }
                        >
                          {s.slope === null ? "—" : `${formatSigned(s.slope)} s/v`}
                        </td>
                        <td className={s.traffic > 0 ? "traffic-cell" : ""}>{secs(s.traffic, 1)} s</td>
                      </tr>
                    )),
                ]),
              ]
            })}
          </tbody>
        </table>
      </div>
      <p className="chart-note">
        Degradación = pendiente del tiempo de vuelta frente a la vuelta del stint (positiva = el
        ritmo cae), neta de combustible y evolución de pista. Tráfico = suma de los sectores más de{" "}
        {secs(analysis.settings.traffic_threshold, 1)} s por encima de la mediana móvil de{" "}
        {analysis.settings.traffic_window} vueltas del piloto.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Desglose de paradas: tiempo en pit lane frente a pérdida neta
// ---------------------------------------------------------------------------
function PitBreakdown({ analysis, focusCar }: { analysis: RaceAnalysis; focusCar: string | null }) {
  const order = useMemo(() => finishingOrder(analysis.laps), [analysis.laps])
  const teams = useMemo(() => new Map(analysis.laps.map((l) => [l.car, l.team])), [analysis.laps])
  const [chosen, setChosen] = useState<string | null>(null)
  const car =
    chosen && order.includes(chosen)
      ? chosen
      : focusCar && order.includes(focusCar)
        ? focusCar
        : (order[0] ?? "")
  const stops = useMemo(
    () => pitStopBreakdown(analysis.laps.filter((l) => l.car === car)),
    [analysis.laps, car],
  )
  const totalLane = stops.reduce((acc, s) => acc + (s.pitLane ?? 0), 0)
  const withLoss = stops.filter((s) => s.netLoss !== null)
  const totalLoss = withLoss.reduce((acc, s) => acc + s.netLoss!, 0)
  const scale = Math.max(1, ...stops.flatMap((s) => [s.pitLane ?? 0, s.netLoss ?? 0]))

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Pit Stop Breakdown</h2>
          <p>Tiempo en el pit lane (PIT_TIME) frente a lo que realmente cuesta cada parada.</p>
        </div>
        <label className="car-select">
          <span>COCHE</span>
          <select value={car} onChange={(event) => setChosen(event.target.value)}>
            {order.map((c) => (
              <option key={c} value={c}>
                #{c} · {teams.get(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="metrics-grid pit-breakdown-metrics">
        <div className="metric-card">
          <span>Paradas</span>
          <strong>{stops.length}</strong>
          <small className="metric-note">
            {stops.filter((s) => s.driverChange).length} con cambio de piloto
          </small>
        </div>
        <div className="metric-card">
          <span>Pit lane total</span>
          <strong>{secs(totalLane, 1)} s</strong>
          <small className="metric-note">Suma de PIT_TIME</small>
        </div>
        <div className="metric-card metric-accent">
          <span>Pérdida neta total</span>
          <strong>{withLoss.length ? `${secs(totalLoss, 1)} s` : "–"}</strong>
          <small className="metric-note">
            {withLoss.length ? `Media ${secs(totalLoss / withLoss.length, 1)} s por parada` : "Sin datos"}
          </small>
        </div>
      </div>

      {stops.length === 0 ? (
        <p className="chart-empty">El #{car} no ha hecho paradas en estos datos.</p>
      ) : (
        <div className="table-scroll stint-table race-table">
          <table>
            <caption className="sr-only">Paradas en boxes del coche {car}</caption>
            <thead>
              <tr>
                <th scope="col">Parada</th>
                <th scope="col">Vueltas</th>
                <th scope="col">Relevo</th>
                <th scope="col">Pit lane</th>
                <th scope="col">V. entrada</th>
                <th scope="col">V. salida</th>
                <th scope="col">Ritmo ref.</th>
                <th scope="col">Pérdida neta</th>
                <th scope="col" className="pit-bars-head">
                  <span className="bar-key lane" /> pit lane <span className="bar-key loss" /> neta
                </th>
              </tr>
            </thead>
            <tbody>
              {stops.map((s) => (
                <tr key={s.outLap}>
                  <td>
                    P{s.index}
                    {s.underNeutralization && <small className="fcy-tag"> FCY</small>}
                  </td>
                  <td>
                    {s.inLap ?? "?"}→{s.outLap}
                  </td>
                  <td>{s.driverChange ? `${s.driverOut} → ${s.driverIn}` : "Sin cambio"}</td>
                  <td>{s.pitLane === null ? "–" : `${secs(s.pitLane)} s`}</td>
                  <td>{formatLapTime(s.inLapTime)}</td>
                  <td>{formatLapTime(s.outLapTime)}</td>
                  <td>{formatLapTime(s.referencePace)}</td>
                  <td className="loss-cell">{s.netLoss === null ? "–" : `${formatSigned(s.netLoss)} s`}</td>
                  <td className="pit-bars" aria-hidden="true">
                    <i className="lane" style={{ width: `${((s.pitLane ?? 0) / scale) * 100}%` }} />
                    <i className="loss" style={{ width: `${(Math.max(0, s.netLoss ?? 0) / scale) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="chart-note">
        Pérdida neta = vuelta de entrada + vuelta de salida − 2 × ritmo de referencia (mediana de las
        vueltas en aire limpio del stint anterior). Las paradas bajo FCY / Safety Car cuestan menos
        porque el resto también rueda lento.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Sección completa
// ---------------------------------------------------------------------------
// Sesiones de carrera: por el nombre del archivo ("23_Analysis_Race.CSV", "Carrera"...).
function isRaceSession(name: string): boolean {
  return /\b(race|carrera|course|rennen)\b/i.test(name.replace(/[_-]/g, " "))
}

export function RaceAnalysisSection({
  state,
  overall,
  focusCar,
  categoryLabel,
  sessionName,
}: {
  state: { data: RaceAnalysis | null; error: string | null; loading: boolean }
  overall: boolean
  focusCar: string | null
  categoryLabel: string
  sessionName: string
}) {
  const { data } = state
  const [forceDistance, setForceDistance] = useState(false)
  // los datos de ejemplo simulan una carrera
  const race = isRaceSession(sessionName) || data?.source === "mock"
  return (
    <section className="race-section" id="race">
      <div className="section-title">
        <div>
          <div className="eyebrow">
            <span /> POST-CARRERA
          </div>
          <h2>Análisis de carrera · {categoryLabel}</h2>
          <p>Gaps, degradación en aire limpio, tráfico y coste real de cada parada.</p>
        </div>
      </div>
      {overall ? (
        <p className="chart-empty panel">
          El análisis de carrera necesita una sesión concreta: ELAPSED no es comparable entre
          sesiones distintas.
        </p>
      ) : state.error ? (
        <p className="chart-empty panel">{state.error}</p>
      ) : !data ? (
        <p className="chart-empty panel">Cargando análisis de carrera…</p>
      ) : (
        <>
          {data.source === "mock" && (
            <div className="insight-bar mock-banner" role="status">
              <span>!</span>
              <p>
                <strong>Datos de ejemplo.</strong> El backend no expone todavía
                /analysis/laps, /stints y /drivers (reinícialo con la última versión de api.py).
                Se muestra una carrera simulada con los mismos campos.
                {data.mockReason ? ` Motivo: ${data.mockReason}` : ""}
              </p>
            </div>
          )}
          {race || forceDistance ? (
            <RaceDistance key={`dist-${data.source}`} analysis={data} focusCar={focusCar} />
          ) : (
            <div className="panel race-panel race-only">
              <div>
                <h2>Distancia de carrera · frente al ganador</h2>
                <p>
                  Solo para sesiones de carrera (el nombre del archivo debe incluir «Race» o
                  «Carrera»). En libres no hay ganador: el orden sale de las vueltas y el tiempo
                  acumulado, que incluye el tiempo en el garaje.
                </p>
              </div>
              <button type="button" className="chip ghost" onClick={() => setForceDistance(true)}>
                Mostrar igualmente
              </button>
            </div>
          )}
          <GapTrace key={`gap-${data.source}`} analysis={data} focusCar={focusCar} />
          <DriverStintTable key={`tbl-${focusCar}`} analysis={data} focusCar={focusCar} />
          <PitBreakdown analysis={data} focusCar={focusCar} />
          <FuelCalculator analysis={data} focusCar={focusCar} />
        </>
      )}
    </section>
  )
}
