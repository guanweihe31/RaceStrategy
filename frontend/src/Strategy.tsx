// Estrategia en carrera para un coche, "al final de la vuelta N": tiempo de conducción
// por piloto, ventana de parada y mapa con la zona de pista donde saldría si para ahora.

import { useMemo, useState } from "react"
import { formatLapTime, formatSigned, useApi } from "./api"
import { secs } from "./chartUtils"
import { finishingOrder, loadSessionLaps, type AnalysisLap, type RaceAnalysis } from "./raceAnalysisData"
import {
  LIVE_REFRESH_MS,
  NEUTRAL_DEFAULTS,
  RULE_PRESETS,
  currentNeutralization,
  driverTimes,
  formatHours,
  measuredSlowdown,
  neutralDecision,
  observedFuelLaps,
  pitLossRange,
  pitWindow,
  trackPositions,
  typicalPitLane,
  type DriveRules,
  type NeutralDecision,
  type NeutralKind,
  type PitWindow,
  type TrackCar,
} from "./strategyCalc"

const DRIVER_COLORS = ["#D4F25C", "#5FD3E8", "#B79CFF", "#FFB454", "#5BD19F", "#FF8FA3"]
const CLASS_COLORS: Record<string, string> = { HYPERCAR: "#B79CFF", LMP2: "#42D6FF", LMGT3: "#5BD19F" }
const FOCUS_COLOR = "#FFD60A"
const ZONE_COLOR = "#FF3B3B"

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------
// Sección
// ---------------------------------------------------------------------------
export function StrategySection({
  analysis,
  focusCar,
  sessionId,
  live,
  onLive,
}: {
  analysis: RaceAnalysis
  focusCar: string | null
  sessionId: string
  live: boolean
  onLive: (on: boolean) => void
}) {
  // todas las clases (el tráfico de otras clases cuenta al salir de boxes)
  const all = useApi(
    analysis.source === "api" ? () => loadSessionLaps(sessionId) : null,
    [sessionId, analysis.source],
    live ? LIVE_REFRESH_MS : null,
  )
  const allLaps = analysis.source === "api" ? (all.data ?? analysis.laps) : analysis.laps

  const order = useMemo(() => finishingOrder(analysis.laps), [analysis.laps])
  const teams = useMemo(() => new Map(analysis.laps.map((l) => [l.car, l.team])), [analysis.laps])
  const [chosen, setChosen] = useState<string | null>(null)
  const car = chosen && order.includes(chosen) ? chosen : focusCar && order.includes(focusCar) ? focusCar : (order[0] ?? "")
  const carLaps = useMemo(
    () => analysis.laps.filter((l) => l.car === car && l.elapsed !== null).sort((a, b) => a.lap - b.lap),
    [analysis.laps, car],
  )
  const firstLap = carLaps[0]?.lap ?? 1
  const lastLap = carLaps[carLaps.length - 1]?.lap ?? 1
  const [lapPick, setLapPick] = useState<number | null>(null)
  // en vivo siempre la última vuelta
  const lap = !live && lapPick !== null && lapPick >= firstLap && lapPick <= lastLap ? lapPick : lastLap
  const now = carLaps.find((l) => l.lap === lap)?.elapsed ?? 0

  const maxElapsed = Math.max(0, ...analysis.laps.map((l) => l.elapsed ?? 0))
  const [raceHours, setRaceHours] = useState<number>(() => Math.max(1, Math.round(maxElapsed / 3600)))
  const raceEnd = raceHours * 3600

  if (!carLaps.length) return null

  return (
    <section className="race-section strategy" id="strategy">
      <div className="section-title">
        <div>
          <div className="eyebrow">
            <span /> ESTRATEGIA
          </div>
          <h2>Pilotos y ventana de parada</h2>
          <p>Todo se calcula con lo que se sabía al final de la vuelta elegida: arrastra para revivir la carrera.</p>
        </div>
      </div>

      <div className="panel race-panel strategy-controls">
        <label className="car-select">
          <span>COCHE</span>
          <select value={car} onChange={(e) => { setChosen(e.target.value); setLapPick(null) }}>
            {order.map((c) => (
              <option key={c} value={c}>
                #{c} · {teams.get(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="lap-slider">
          <span>
            AL FINAL DE LA VUELTA <b>{lap}</b> · tiempo de carrera {clock(now)}
          </span>
          <input
            type="range"
            min={firstLap}
            max={lastLap}
            value={lap}
            disabled={live}
            onChange={(e) => setLapPick(Number(e.target.value))}
          />
        </label>
        <label className={`check live-toggle${live ? " on" : ""}`} title="Recarga los datos cada 15 s y sigue la última vuelta (para usar con el colector de LMU)">
          <input type="checkbox" checked={live} onChange={(e) => onLive(e.target.checked)} />
          <span className="live-dot" aria-hidden="true" />
          En vivo
        </label>
        <label className="fuel-field strategy-hours">
          <span>Duración de la carrera</span>
          <span className="fuel-input">
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={raceHours}
              onChange={(e) => Number(e.target.value) > 0 && setRaceHours(Number(e.target.value))}
            />
            <small>h</small>
          </span>
        </label>
      </div>

      <DriverTimePanel key={`dt-${car}`} carLaps={carLaps} now={now} raceEnd={raceEnd} />
      <CarPlan key={`plan-${car}`} car={car} carLaps={carLaps} allLaps={allLaps} lap={lap} now={now} raceEnd={raceEnd} live={live} />
    </section>
  )
}

// Ajustes de parada compartidos por el asistente de neutralizaciones y la ventana.
function CarPlan(props: {
  car: string
  carLaps: AnalysisLap[]
  allLaps: AnalysisLap[]
  lap: number
  now: number
  raceEnd: number
  live: boolean
}) {
  const { carLaps, lap, raceEnd } = props
  const observedFuel = useMemo(() => observedFuelLaps(carLaps), [carLaps])
  const observedLoss = useMemo(() => pitLossRange(carLaps), [carLaps])
  const [fuelLaps, setFuelLaps] = useState<number>(observedFuel ?? 15)
  const [loss, setLoss] = useState<{ min: number; max: number }>(
    observedLoss ? { min: Math.round(observedLoss.min), max: Math.round(observedLoss.max) } : { min: 60, max: 90 },
  )
  const win = useMemo(() => pitWindow(carLaps, lap, fuelLaps, raceEnd), [carLaps, lap, fuelLaps, raceEnd])
  const shared = { ...props, fuelLaps, setFuelLaps, loss, setLoss, win, observedFuel, observedLoss }
  return (
    <>
      <NeutralAssistant {...shared} />
      <PitWindowPanel {...shared} />
    </>
  )
}

type PlanProps = {
  car: string
  carLaps: AnalysisLap[]
  allLaps: AnalysisLap[]
  lap: number
  now: number
  raceEnd: number
  live: boolean
  fuelLaps: number
  setFuelLaps: (v: number) => void
  loss: { min: number; max: number }
  setLoss: (v: { min: number; max: number }) => void
  win: PitWindow | null
  observedFuel: number | null
  observedLoss: { min: number; max: number } | null
}

// ---------------------------------------------------------------------------
// Asistente: ¿parar si sale ahora FCY / VSC / Safety Car?
// ---------------------------------------------------------------------------
const VERDICT_TEXT: Record<NeutralDecision["verdict"], string> = {
  must: "PARA YA",
  pit: "PARA",
  marginal: "DUDOSO",
  stay: "QUÉDATE FUERA",
}

function NeutralAssistant({ car, carLaps, allLaps, lap, now, fuelLaps, loss, win, live }: PlanProps) {
  const measured = useMemo(() => measuredSlowdown(allLaps), [allLaps])
  const measuredPitLane = useMemo(() => typicalPitLane(carLaps), [carLaps])
  const [pitLane, setPitLane] = useState<number>(() => Math.round(measuredPitLane ?? Math.max(loss.max + 10, 70)))
  const [params, setParams] = useState(() =>
    Object.fromEntries(
      (Object.keys(NEUTRAL_DEFAULTS) as NeutralKind[]).map((k) => [
        k,
        { slow: Number((measured[k]?.factor ?? NEUTRAL_DEFAULTS[k].slow).toFixed(2)), duration: NEUTRAL_DEFAULTS[k].duration, open: true },
      ]),
    ) as Record<NeutralKind, { slow: number; duration: number; open: boolean }>,
  )
  const [showParams, setShowParams] = useState(false)
  const lossGreen = (loss.min + loss.max) / 2
  const refLap = win?.lapTime ?? 100
  const current = useMemo(() => currentNeutralization(allLaps, now, refLap), [allLaps, now, refLap])
  const positions = useMemo(() => trackPositions(allLaps, now, car, refLap), [allLaps, now, car, refLap])

  const decisions = (Object.keys(NEUTRAL_DEFAULTS) as NeutralKind[]).map((kind) => {
    const d = neutralDecision({
      kind,
      slow: params[kind].slow,
      duration: params[kind].duration,
      pitLaneOpen: params[kind].open,
      pitLane,
      lossGreen,
      win,
      fuelLaps,
    })
    // con quién saldría (distancia en pista a ritmo de carrera, como en el mapa)
    const wrap = (b: number) => b + refLap * Math.max(0, Math.round((d.lossNeutral - b) / refLap))
    const near = positions
      .filter((p) => p.car !== car)
      .map((p) => ({ ...p, diff: wrap(p.behind) - d.lossNeutral }))
      .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
      .slice(0, 3)
      .sort((a, b) => a.diff - b.diff)
    return { ...d, near }
  })
  const set = (kind: NeutralKind, patch: Partial<{ slow: number; duration: number; open: boolean }>) =>
    setParams({ ...params, [kind]: { ...params[kind], ...patch } })

  return (
    <article className={`panel race-panel neutral-assistant${current ? " active" : ""}`}>
      <div className="panel-heading race-heading">
        <div>
          <h2>Asistente de parada con FCY / VSC / Safety Car · #{car}</h2>
          <p>
            Si saliera ahora mismo (al final de la vuelta {lap}), ¿compensa parar? Se recalcula con
            cada vuelta{live ? " y cada 15 s en vivo" : ""}: parar con bandera cuesta menos porque los
            demás van lentos mientras estás en boxes.
          </p>
        </div>
        <button type="button" className="chip ghost" onClick={() => setShowParams(!showParams)}>
          {showParams ? "Ocultar parámetros" : "Parámetros"}
        </button>
      </div>

      {current && (
        <div className="neutral-now" role="alert">
          <b>{current} EN CURSO</b> en la vuelta {lap}: decisión destacada abajo.
        </div>
      )}

      {showParams && (
        <div className="neutral-params">
          <label className="fuel-field">
            <span>Tiempo en el pit lane (PIT_TIME)</span>
            <span className="fuel-input">
              <input type="number" min={5} step={1} value={pitLane} onChange={(e) => Number(e.target.value) > 0 && setPitLane(Number(e.target.value))} />
              <small>s</small>
            </span>
          </label>
          {(Object.keys(NEUTRAL_DEFAULTS) as NeutralKind[]).map((kind) => (
            <div className="neutral-param-row" key={kind}>
              <strong>{kind}</strong>
              <label className="fuel-field">
                <span>Vuelta {kind} / vuelta verde{measured[kind] ? ` (medido ${measured[kind]!.factor.toFixed(2)}, ${measured[kind]!.samples} v.)` : ""}</span>
                <span className="fuel-input">
                  <input type="number" min={1} step={0.1} value={params[kind].slow} onChange={(e) => Number(e.target.value) >= 1 && set(kind, { slow: Number(e.target.value) })} />
                  <small>×</small>
                </span>
              </label>
              <label className="fuel-field">
                <span>Duración esperada</span>
                <span className="fuel-input">
                  <input type="number" min={0} step={30} value={params[kind].duration} onChange={(e) => set(kind, { duration: Math.max(0, Number(e.target.value) || 0) })} />
                  <small>s</small>
                </span>
              </label>
              <label className="check fuel-check">
                <input type="checkbox" checked={params[kind].open} onChange={(e) => set(kind, { open: e.target.checked })} />
                Pit lane abierto
              </label>
            </div>
          ))}
          <p className="chart-note">
            La pérdida en verde ({Math.round(lossGreen)} s) y las vueltas por depósito ({fuelLaps}) son las de
            la ventana de parada (abajo). Comprueba en el reglamento si el pit lane se cierra con cada
            bandera.
          </p>
        </div>
      )}

      <div className="neutral-cards">
        {decisions.map((d) => (
          <div key={d.kind} className={`neutral-card v-${d.verdict}${current === d.kind ? " current" : ""}`}>
            <div className="neutral-card-head">
              <span>
                <strong>{d.kind}</strong>
                <small>{NEUTRAL_DEFAULTS[d.kind].label}</small>
              </span>
              <b className="verdict">{VERDICT_TEXT[d.verdict]}</b>
            </div>
            <div className="neutral-gain">
              {d.verdict === "must" ? "sin combustible" : `${d.gain >= 0 ? "gana" : "pierde"} ${secs(Math.abs(d.gain), 0)} s`}
              <small> frente a parar luego en verde</small>
            </div>
            <ul>
              {d.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {d.near.length > 0 && (
              <p className="neutral-near">
                Saldría cerca de{" "}
                {d.near.map((n, i) => (
                  <span key={n.car}>
                    {i > 0 && ", "}
                    <b>#{n.car}</b> <small>({n.category}, {n.diff >= 0 ? "delante" : "detrás"} {secs(Math.abs(n.diff), 0)} s)</small>
                  </span>
                ))}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="chart-note">
        Ganancia = coste de la próxima parada en verde − (parada ahora con bandera + paradas extra que
        obligue). «Dudoso» = menos de 5 s de diferencia. No tiene en cuenta neumáticos ni posiciones
        perdidas en la cola del Safety Car.
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Tiempo de conducción
// ---------------------------------------------------------------------------
function DriverTimePanel({ carLaps, now, raceEnd }: { carLaps: AnalysisLap[]; now: number; raceEnd: number }) {
  const [preset, setPreset] = useState(raceEnd >= 20 * 3600 ? "lemans" : "custom")
  const [custom, setCustom] = useState<DriveRules>(RULE_PRESETS.lemans.rules)
  const [minimums, setMinimums] = useState<Record<string, number>>({})
  const [includePit, setIncludePit] = useState(true)
  const rules = preset === "custom" ? custom : RULE_PRESETS[preset].rules

  const result = useMemo(
    () => driverTimes(carLaps, now, raceEnd, rules, minimums, includePit),
    [carLaps, now, raceEnd, rules, minimums, includePit],
  )
  const names = result.drivers.map((d) => d.driver)
  const color = (driver: string) => DRIVER_COLORS[Math.max(0, names.indexOf(driver)) % DRIVER_COLORS.length]
  const ruleField = (key: keyof DriveRules, label: string) => (
    <label className="fuel-field">
      <span>{label}</span>
      <span className="fuel-input">
        <input
          type="number"
          min={0}
          step={0.5}
          value={rules[key] ?? ""}
          placeholder="sin límite"
          disabled={preset !== "custom"}
          onChange={(e) => setCustom({ ...custom, [key]: e.target.value === "" ? null : Number(e.target.value) })}
        />
        <small>h</small>
      </span>
    </label>
  )

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Tiempo de conducción por piloto</h2>
          <p>
            Suma de las vueltas de cada piloto hasta la vuelta elegida, frente a los máximos del
            reglamento y al mínimo que tú indiques para cada piloto (p. ej. Bronce). Quedan{" "}
            <b>{formatHours(result.remaining)}</b> de carrera.
          </p>
        </div>
        <label className="car-select">
          <span>REGLAS</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(RULE_PRESETS).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="fuel-grid">
        {ruleField("maxTotalH", "Máximo total por piloto")}
        {ruleField("windowH", "Ventana deslizante")}
        {ruleField("maxInWindowH", "Máximo en la ventana")}
        <label className="check fuel-check">
          <input type="checkbox" checked={includePit} onChange={(e) => setIncludePit(e.target.checked)} />
          Contar el tiempo en el pit lane de la vuelta de salida
        </label>
      </div>

      {result.impossible && (
        <div className="insight-bar strategy-alert" role="alert">
          <span>!</span>
          <p>
            <strong>Los mínimos ya no caben:</strong> suman más tiempo pendiente que lo que queda de carrera.
          </p>
        </div>
      )}

      <div className="table-scroll stint-table race-table">
        <table>
          <caption className="sr-only">Tiempo de conducción por piloto</caption>
          <thead>
            <tr>
              <th scope="col">Piloto</th>
              <th scope="col">Conducido</th>
              <th scope="col">Stints</th>
              <th scope="col">Tramo más largo</th>
              <th scope="col">Máx. en {rules.windowH ?? "–"} h</th>
              <th scope="col">Mínimo</th>
              <th scope="col">Falta</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {result.drivers.map((d) => (
              <tr key={d.driver} className={`drive-${d.status}`}>
                <td>
                  <i className="dot" style={{ background: color(d.driver) }} />
                  {d.driver}
                </td>
                <td>{formatHours(d.total)}</td>
                <td>{d.stints}</td>
                <td>{formatHours(d.longest)}</td>
                <td>{d.windowMax === null ? "–" : formatHours(d.windowMax)}</td>
                <td>
                  <span className="fuel-input min-input">
                    <input
                      type="number"
                      min={0}
                      step={0.25}
                      value={minimums[d.driver] ?? 0}
                      aria-label={`Mínimo de conducción de ${d.driver} en horas`}
                      onChange={(e) => setMinimums({ ...minimums, [d.driver]: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <small>h</small>
                  </span>
                </td>
                <td>{d.minimum ? (d.needed ? formatHours(d.needed) : "cumplido") : "–"}</td>
                <td className="drive-status">{d.notes.length ? d.notes.join(" · ") : "OK"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="fuel-subtitle">Quién ha conducido cuándo</h3>
      <div className="gantt" aria-hidden="true">
        {result.drivers.map((d) => (
          <div className="gantt-row" key={d.driver}>
            <span>{d.driver}</span>
            <div className="gantt-track">
              {result.intervals
                .filter((i) => i.driver === d.driver)
                .map((i) => (
                  <i
                    key={`${i.stint}-${i.start}`}
                    title={`Stint ${i.stint}: ${clock(i.start)} → ${clock(i.end)} (${formatHours(i.end - i.start)})`}
                    style={{
                      left: `${(i.start / raceEnd) * 100}%`,
                      width: `${Math.max(0.3, ((i.end - i.start) / raceEnd) * 100)}%`,
                      background: color(d.driver),
                    }}
                  />
                ))}
              <b className="gantt-now" style={{ left: `${Math.min(100, (now / raceEnd) * 100)}%` }} />
            </div>
          </div>
        ))}
        <div className="gantt-axis">
          {Array.from({ length: Math.floor(raceEnd / 3600) + 1 }, (_, h) => h)
            .filter((h, _, all) => all.length <= 13 || h % 2 === 0)
            .map((h) => (
              <small key={h} style={{ left: `${((h * 3600) / raceEnd) * 100}%` }}>
                {h} h
              </small>
            ))}
        </div>
      </div>
      <p className="chart-note">
        Valores de reglas orientativos: compruébalos en el reglamento deportivo de la prueba. El
        tiempo de cada vuelta se asigna al piloto que la condujo (la de entrada, al que sale; la de
        salida, al que entra).
      </p>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Ventana de parada + mapa de reincorporación
// ---------------------------------------------------------------------------
function PitWindowPanel({
  car,
  carLaps,
  allLaps,
  lap,
  now,
  fuelLaps,
  setFuelLaps,
  loss,
  setLoss,
  win,
  observedFuel,
  observedLoss,
}: PlanProps) {
  const refLap = win?.lapTime ?? 100
  const positions = useMemo(() => trackPositions(allLaps, now, car, refLap), [allLaps, now, car, refLap])
  const focus = positions.find((p) => p.car === car)
  const category = carLaps[0]?.category ?? ""
  const lo = Math.min(loss.min, loss.max)
  const hi = Math.max(loss.min, loss.max)
  const mid = (lo + hi) / 2
  // distancia por detrás llevada a la vuelta más cercana a la pérdida (si la pérdida es
  // mayor que una vuelta, un coche a 20 s por detrás también está a 20 s + 1 vuelta)
  const wrap = (behind: number) => behind + refLap * Math.max(0, Math.round((mid - behind) / refLap))
  const nearby = positions
    .filter((p) => p.car !== car)
    .map((p) => ({ ...p, behind: wrap(p.behind) }))
    .filter((p) => p.behind >= lo - 15 && p.behind <= hi + 15)
    .sort((a, b) => a.behind - b.behind)

  // tira de vueltas: desde N hasta pasado el cierre
  const stripEnd = win?.close != null ? Math.max(win.close + 4, lap + 12) : lap + 12
  const strip = Array.from({ length: Math.min(60, stripEnd - lap) }, (_, i) => lap + 1 + i)
  const cell = (n: number) => {
    if (!win || win.open === null || win.close === null) return "neutral"
    if (n > win.close) return "late"
    if (n >= win.open) return "open"
    return "early"
  }

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Ventana de parada y salida de boxes · #{car}</h2>
          <p>
            Ventana: primera vuelta en la que parar no obliga a una parada extra hasta el final,
            y última vuelta que permite el combustible.
          </p>
        </div>
      </div>

      <div className="fuel-grid">
        <label className="fuel-field">
          <span>Vueltas por depósito</span>
          <span className="fuel-input">
            <input type="number" min={1} step={1} value={fuelLaps} onChange={(e) => Number(e.target.value) >= 1 && setFuelLaps(Math.round(Number(e.target.value)))} />
            <small>v</small>
          </span>
        </label>
        <label className="fuel-field">
          <span>Pérdida en boxes (mín.)</span>
          <span className="fuel-input">
            <input type="number" min={0} step={1} value={loss.min} onChange={(e) => setLoss({ ...loss, min: Math.max(0, Number(e.target.value) || 0) })} />
            <small>s</small>
          </span>
        </label>
        <label className="fuel-field">
          <span>Pérdida en boxes (máx.)</span>
          <span className="fuel-input">
            <input type="number" min={0} step={1} value={loss.max} onChange={(e) => setLoss({ ...loss, max: Math.max(0, Number(e.target.value) || 0) })} />
            <small>s</small>
          </span>
        </label>
        <p className="chart-note strategy-hint">
          {observedFuel ? `Stint más largo del #${car}: ${observedFuel} vueltas. ` : ""}
          {observedLoss
            ? `Pérdida neta en sus paradas en verde: ${secs(observedLoss.min, 0)}–${secs(observedLoss.max, 0)} s.`
            : "Sin paradas en verde con pérdida medible: valores por defecto."}
        </p>
      </div>

      {win && (
        <div className="metrics-grid win-metrics">
          <div className="metric-card">
            <span>En este depósito</span>
            <strong>{win.lapsOnTank} v</strong>
            <small className="metric-note">quedan ~{win.fuelLeft} v de combustible</small>
          </div>
          <div className="metric-card">
            <span>Hasta el final</span>
            <strong>~{win.remainingLaps} v</strong>
            <small className="metric-note">a {formatLapTime(win.lapTime)} por vuelta</small>
          </div>
          <div className="metric-card">
            <span>Paradas que faltan</span>
            <strong>{win.stopsNeeded}</strong>
            <small className="metric-note">{win.stopsNeeded ? "como mínimo" : "llega sin parar"}</small>
          </div>
          <div className="metric-card metric-accent">
            <span>Ventana</span>
            <strong>{win.open === null ? "—" : win.open === win.close ? `v. ${win.open}` : `v. ${win.open}–${win.close}`}</strong>
            <small className="metric-note">
              {win.close === null ? "no hace falta parar" : win.close <= lap ? "¡sin combustible ya!" : `cierra en ${win.close - lap} v`}
            </small>
          </div>
        </div>
      )}

      {win?.open != null && (
        <>
          <div className="lap-strip" aria-label="Vueltas siguientes y ventana de parada">
            {strip.map((n) => (
              <span key={n} className={`lap-cell ${cell(n)}`} title={`Vuelta ${n}`}>
                {n}
              </span>
            ))}
          </div>
          <div className="legend">
            <span><i className="bar-key lap-early" /> Pronto (añade una parada)</span>
            <span><i className="bar-key lap-open" /> Ventana</span>
            <span><i className="bar-key lap-late" /> Sin combustible</span>
          </div>
        </>
      )}

      <div className="rejoin">
        <TrackMap cars={positions} focus={car} focusCategory={category} lo={lo} hi={hi} refLap={refLap} carLaps={carLaps} />
        <div className="rejoin-list">
          <h3>Si para al final de la vuelta {lap}</h3>
          {!focus ? (
            <p className="chart-empty">No hay posición en pista para el #{car} en ese instante.</p>
          ) : (
            <>
              <p>
                Sale entre <b>{secs(lo, 0)}</b> y <b>{secs(hi, 0)} s</b> por detrás de donde está ahora:
                la <span className="zone-word">zona roja</span>.
                {hi > refLap && " La pérdida es mayor que una vuelta: sale además una vuelta por detrás."}
              </p>
              {nearby.length === 0 ? (
                <p className="chart-note">Nadie en esa zona: saldría en pista libre.</p>
              ) : (
                <ul>
                  {nearby.map((p) => {
                    const inZone = p.behind >= lo && p.behind <= hi
                    const diff = p.behind - mid
                    return (
                      <li key={p.car} className={inZone ? "in-zone" : ""}>
                        <i className="dot" style={{ background: CLASS_COLORS[p.category] ?? "#9FB0C2" }} />
                        <b>#{p.car}</b> <small>{p.category}{p.category === category ? " · misma clase" : ""}</small>
                        <em>
                          {diff >= 0 ? `saldría delante (${formatSigned(diff)} s)` : `saldría detrás (${formatSigned(diff)} s)`}
                          {p.inPits ? " · en boxes" : ""}
                        </em>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
          <p className="chart-note">
            Posiciones interpoladas entre pasos por meta; el trazado es esquemático (los archivos de
            tiempos no traen GPS). Diferencias calculadas con la pérdida media ({secs(mid, 0)} s).
          </p>
        </div>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Mapa esquemático: óvalo con meta, pit lane, sectores, coches y zona roja
// ---------------------------------------------------------------------------
const MAP = { w: 560, h: 300, r: 100, a: 300 }
const X0 = MAP.w / 2 - MAP.a / 2
const CY = MAP.h / 2 + 8
const PERIMETER = 2 * MAP.a + 2 * Math.PI * MAP.r
const SF = MAP.a * 0.55 // meta: hacia la mitad de la recta superior

function along(d: number): [number, number] {
  const { a, r } = MAP
  let x = ((d % PERIMETER) + PERIMETER) % PERIMETER
  if (x < a) return [X0 + x, CY - r]
  x -= a
  if (x < Math.PI * r) {
    const t = -Math.PI / 2 + x / r
    return [X0 + a + r * Math.cos(t), CY + r * Math.sin(t)]
  }
  x -= Math.PI * r
  if (x < a) return [X0 + a - x, CY + r]
  x -= a
  const t = Math.PI / 2 + x / r
  return [X0 + r * Math.cos(t), CY + r * Math.sin(t)]
}
const at = (fraction: number) => along(SF + fraction * PERIMETER)

function TrackMap({
  cars,
  focus,
  focusCategory,
  lo,
  hi,
  refLap,
  carLaps,
}: {
  cars: TrackCar[]
  focus: string
  focusCategory: string
  lo: number
  hi: number
  refLap: number
  carLaps: AnalysisLap[]
}) {
  const me = cars.find((c) => c.car === focus)
  const base = me?.fraction ?? 0
  const span = Math.min(1, (hi - lo) / refLap)
  const zone = Array.from({ length: 61 }, (_, i) => {
    const f = base - hi / refLap + (span * i) / 60
    return at(f).join(",")
  }).join(" ")
  const exit = at(base - (lo + hi) / 2 / refLap)

  // límites de sector con la mediana de los parciales del coche
  const median = (xs: number[]) => (xs.length ? [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] : null)
  const green = carLaps.filter((l) => l.is_green_racing)
  const s1 = median(green.flatMap((l) => (l.s1 ? [l.s1] : [])))
  const s2 = median(green.flatMap((l) => (l.s2 ? [l.s2] : [])))
  const lapT = median(green.flatMap((l) => (l.lap_time ? [l.lap_time] : [])))
  const sectors = s1 && s2 && lapT ? [s1 / lapT, (s1 + s2) / lapT] : []

  const pitY = CY - MAP.r - 22
  const pitIn = X0 + SF - 110
  const pitOut = X0 + SF + 70

  return (
    <svg className="track-map" viewBox={`0 0 ${MAP.w} ${MAP.h}`} role="img" aria-label="Mapa esquemático con la zona donde saldría de boxes">
      <rect x="0" y="0" width={MAP.w} height={MAP.h} rx="6" fill="#0a111a" />
      {/* pit lane */}
      <polyline
        points={`${pitIn - 30},${CY - MAP.r} ${pitIn},${pitY} ${pitOut},${pitY} ${pitOut + 30},${CY - MAP.r}`}
        fill="none"
        stroke="#2a3b4f"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <text x={(pitIn + pitOut) / 2} y={pitY - 8} textAnchor="middle" fill="#6f8398" fontSize="10">PIT LANE</text>
      {/* pista */}
      <polyline
        points={Array.from({ length: 241 }, (_, i) => along((i / 240) * PERIMETER).join(",")).join(" ")}
        fill="none"
        stroke="#1f3044"
        strokeWidth="16"
        strokeLinejoin="round"
      />
      {/* zona roja */}
      {me && <polyline points={zone} fill="none" stroke={ZONE_COLOR} strokeOpacity="0.55" strokeWidth="18" strokeLinecap="round" />}
      {/* meta y sectores */}
      {[0, ...sectors].map((f, i) => {
        const [x, y] = at(f)
        const [x2, y2] = at(f + 0.002)
        const nx = -(y2 - y)
        const ny = x2 - x
        const k = 13 / Math.hypot(nx, ny || 1)
        return (
          <g key={`s${i}`}>
            <line x1={x - nx * k} y1={y - ny * k} x2={x + nx * k} y2={y + ny * k} stroke={i === 0 ? "#E6EDF5" : "#4b6a8c"} strokeWidth={i === 0 ? 3 : 2} />
            <text x={x + nx * k * 1.8} y={y + ny * k * 1.8 + 4} textAnchor="middle" fill={i === 0 ? "#E6EDF5" : "#6f8398"} fontSize="10">
              {i === 0 ? "META" : `S${i + 1}`}
            </text>
          </g>
        )
      })}
      {/* coches */}
      {cars
        .slice()
        .sort((p, q) => (p.car === focus ? 1 : 0) - (q.car === focus ? 1 : 0))
        .map((c) => {
          const [x, y] = at(c.fraction)
          const isFocus = c.car === focus
          const mid = (lo + hi) / 2
          const behind = c.behind + refLap * Math.max(0, Math.round((mid - c.behind) / refLap))
          const inZone = !isFocus && behind >= lo && behind <= hi
          const fill = isFocus ? FOCUS_COLOR : CLASS_COLORS[c.category] ?? "#9FB0C2"
          return (
            <g key={c.car} opacity={isFocus || c.category === focusCategory || inZone ? 1 : 0.5}>
              <title>{`#${c.car} ${c.team} (${c.category})${c.inPits ? " · en boxes" : ""}`}</title>
              <circle cx={x} cy={y} r={isFocus ? 9 : 6} fill={fill} stroke={inZone ? ZONE_COLOR : "#0a111a"} strokeWidth={inZone ? 3 : 1.5} />
              {(isFocus || inZone || c.category === focusCategory) && (
                <text x={x} y={y - (isFocus ? 13 : 10)} textAnchor="middle" fill={isFocus ? FOCUS_COLOR : "#dbe7f3"} fontSize={isFocus ? 12 : 10} fontWeight={isFocus ? 700 : 400}>
                  {c.car}
                </text>
              )}
            </g>
          )
        })}
      {me && (
        <text x={Math.min(MAP.w - 40, Math.max(40, exit[0]))} y={Math.min(MAP.h - 24, Math.max(16, exit[1] + 30 * (exit[1] > CY ? 1 : -1) + 4))} textAnchor="middle" fill={ZONE_COLOR} fontSize="11" fontWeight="700">
          SALE AQUÍ
        </text>
      )}
      <text x="12" y={MAP.h - 12} fill="#62758a" fontSize="10">sentido de la marcha: horario →</text>
    </svg>
  )
}
