// Calculadora de combustible por parada y comparación servicio completo vs splash & dash.
//
// Modelo (todo ajustable):
//   PIT_TIME (Al Kamel)  = tránsito por el pit lane + tiempo parado
//   tiempo parado        = máx(tiempo mínimo de parada, trabajo)
//   trabajo              = repostaje (+ cambio de piloto) + neumáticos
//     · el cambio de piloto puede ir en paralelo al repostaje (por defecto) o después
//     · los neumáticos van después del repostaje (en WEC no se cambian mientras se reposta)
//   repostaje (s)        = combustible / caudal
// Con eso, de cada parada real se despeja cuánto combustible se metió.

import { useMemo, useState } from "react"
import { secs } from "./chartUtils"
import { finishingOrder, pitStopBreakdown, type RaceAnalysis } from "./raceAnalysisData"

type Params = {
  transit: number // s, pit lane sin pararse (entrada → salida al limitador)
  minStop: number // s, tiempo parado mínimo reglamentario
  flow: number // unidades/s (L/s o %/s)
  driver: number // s, cambio de piloto
  tyres: number // s, cambio de 4 neumáticos
  parallelDriver: boolean
  perLap: number // consumo por vuelta
  tank: number // capacidad
  splashLaps: number // vueltas que debe cubrir el splash & dash
}

const DEFAULTS: Params = {
  transit: 25,
  minStop: 30,
  flow: 2,
  driver: 12,
  tyres: 25,
  parallelDriver: true,
  perLap: 3,
  tank: 90,
  splashLaps: 5,
}

type Service = { driver: boolean; tyres: boolean }

/** Tiempo parado para meter `fuel` con un servicio dado, desglosado. */
function stopTime(fuel: number, service: Service, p: Params) {
  const refuel = fuel / p.flow
  const driver = service.driver ? p.driver : 0
  const driverExtra = p.parallelDriver ? Math.max(0, driver - refuel) : driver
  const tyres = service.tyres ? p.tyres : 0
  const work = refuel + driverExtra + tyres
  const padding = Math.max(0, p.minStop - work)
  return { refuel, driverExtra, tyres, padding, stationary: work + padding, total: p.transit + work + padding }
}

/** Combustible metido en una parada real a partir de su tiempo parado. */
function fuelFromStop(stationary: number, service: Service, p: Params) {
  const tyres = service.tyres ? p.tyres : 0
  const driver = service.driver ? p.driver : 0
  let refuel = p.parallelDriver ? stationary - tyres : stationary - tyres - driver
  // "como mucho": parada en el tiempo mínimo (pudo meter menos y esperar) o el cambio
  // de piloto en paralelo tardó más que el repostaje (el repostaje queda oculto)
  let upperBound = stationary <= p.minStop + 0.5
  if (p.parallelDriver && service.driver && refuel <= driver) upperBound = true
  refuel = Math.max(0, refuel)
  const raw = refuel * p.flow
  return { fuel: Math.min(raw, p.tank), capped: raw > p.tank, upperBound }
}

function NumberField({
  label,
  unit,
  value,
  step = 0.5,
  onChange,
}: {
  label: string
  unit: string
  value: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="fuel-field">
      <span>{label}</span>
      <span className="fuel-input">
        <input
          type="number"
          min={0}
          step={step}
          value={value}
          onChange={(event) => {
            const v = Number(event.target.value)
            if (Number.isFinite(v) && v >= 0) onChange(v)
          }}
        />
        <small>{unit}</small>
      </span>
    </label>
  )
}

export function FuelCalculator({ analysis, focusCar }: { analysis: RaceAnalysis; focusCar: string | null }) {
  const [p, setP] = useState<Params>(DEFAULTS)
  const [unit, setUnit] = useState<"L" | "%">("L")
  const [chosen, setChosen] = useState<string | null>(null)
  const [services, setServices] = useState<Record<string, Service>>({})
  const set = (patch: Partial<Params>) => setP({ ...p, ...patch })

  const order = useMemo(() => finishingOrder(analysis.laps), [analysis.laps])
  const teams = useMemo(() => new Map(analysis.laps.map((l) => [l.car, l.team])), [analysis.laps])
  const car =
    chosen && order.includes(chosen) ? chosen : focusCar && order.includes(focusCar) ? focusCar : (order[0] ?? "")
  const carLaps = useMemo(() => analysis.laps.filter((l) => l.car === car), [analysis.laps, car])
  const stops = useMemo(() => pitStopBreakdown(carLaps), [carLaps])
  const lastLap = Math.max(0, ...carLaps.map((l) => l.lap))
  // PIT_TIME más corto de la categoría: cota superior de tránsito + parada mínima
  const shortest = Math.min(
    ...analysis.laps.flatMap((l) => (l.is_out_lap && l.lap > 1 && l.pit_time !== null ? [l.pit_time] : [])),
  )

  const rows = stops.map((s, i) => {
    const key = `${car}|${s.outLap}`
    const service = services[key] ?? { driver: s.driverChange, tyres: false }
    const stationary = s.pitLane === null ? null : s.pitLane - p.transit
    const solved = stationary === null ? null : fuelFromStop(Math.max(0, stationary), service, p)
    // vueltas del stint que empieza en esta parada: salida → siguiente entrada (o final)
    const next = stops[i + 1]
    const endLap = next ? (next.inLap ?? next.outLap - 1) : lastLap
    const stintLaps = Math.max(0, endLap - s.outLap + 1)
    return { stop: s, key, service, stationary, solved, stintLaps, need: stintLaps * p.perLap }
  })

  const fullFuel = p.tank
  const splashFuel = p.splashLaps * p.perLap
  const scenarios = [
    { name: "Servicio completo", detail: "combustible + neumáticos + piloto", r: stopTime(fullFuel, { driver: true, tyres: true }, p) },
    { name: "Combustible + piloto", detail: "sin neumáticos", r: stopTime(fullFuel, { driver: true, tyres: false }, p) },
    { name: "Combustible + neumáticos", detail: "sin cambio de piloto", r: stopTime(fullFuel, { driver: false, tyres: true }, p) },
    { name: "Splash & dash", detail: `solo ${secs(splashFuel, 1)} ${unit} para ${p.splashLaps} vueltas`, r: stopTime(splashFuel, { driver: false, tyres: false }, p) },
  ]
  const splash = scenarios[3].r.total
  const scale = Math.max(...scenarios.map((s) => s.r.total))

  return (
    <article className="panel race-panel">
      <div className="panel-heading race-heading">
        <div>
          <h2>Combustible por parada · servicio completo vs splash &amp; dash</h2>
          <p>
            Tiempo parado = PIT_TIME − tránsito por el pit lane. De ahí, con el caudal, el tiempo
            mínimo de parada y lo que tardan el cambio de piloto y de neumáticos, se despeja el
            combustible que entró en cada parada.
          </p>
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

      <div className="fuel-grid" role="group" aria-label="Parámetros de la parada">
        <NumberField label="Tránsito pit lane" unit="s" value={p.transit} onChange={(v) => set({ transit: v })} />
        <NumberField label="Parada mínima" unit="s" value={p.minStop} onChange={(v) => set({ minStop: v })} />
        <NumberField label="Caudal de repostaje" unit={`${unit}/s`} step={0.1} value={p.flow} onChange={(v) => v > 0 && set({ flow: v })} />
        <NumberField label="Cambio de piloto" unit="s" value={p.driver} onChange={(v) => set({ driver: v })} />
        <NumberField label="Cambio de neumáticos" unit="s" value={p.tyres} onChange={(v) => set({ tyres: v })} />
        <NumberField label="Consumo por vuelta" unit={unit} step={0.1} value={p.perLap} onChange={(v) => set({ perLap: v })} />
        <NumberField label="Depósito / energía" unit={unit} step={1} value={p.tank} onChange={(v) => set({ tank: v })} />
        <NumberField label="Splash: vueltas a cubrir" unit="v" step={1} value={p.splashLaps} onChange={(v) => set({ splashLaps: Math.round(v) })} />
        <label className="fuel-field">
          <span>Unidad</span>
          <select value={unit} onChange={(event) => setUnit(event.target.value as "L" | "%")}>
            <option value="L">Litros</option>
            <option value="%">% energía virtual</option>
          </select>
        </label>
        <label className="check fuel-check">
          <input
            type="checkbox"
            checked={p.parallelDriver}
            onChange={(event) => set({ parallelDriver: event.target.checked })}
          />
          Cambio de piloto durante el repostaje
        </label>
        <button type="button" className="chip ghost" onClick={() => setP(DEFAULTS)}>
          Valores por defecto
        </button>
      </div>
      {Number.isFinite(shortest) && (
        <p className="chart-note">
          PIT_TIME más corto de la categoría en estos datos: {secs(shortest, 1)} s (tránsito +
          parada más rápida). El tránsito no puede ser mayor.
        </p>
      )}

      <h3 className="fuel-subtitle">Paradas del #{car}: combustible añadido</h3>
      {rows.length === 0 ? (
        <p className="chart-empty">El #{car} no ha hecho paradas en estos datos.</p>
      ) : (
        <div className="table-scroll stint-table race-table">
          <table>
            <caption className="sr-only">Combustible estimado por parada del coche {car}</caption>
            <thead>
              <tr>
                <th scope="col">Parada</th>
                <th scope="col">PIT_TIME</th>
                <th scope="col">Parado</th>
                <th scope="col">Piloto</th>
                <th scope="col">Neumáticos</th>
                <th scope="col">Combustible</th>
                <th scope="col">Da para</th>
                <th scope="col">Stint siguiente</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ stop, key, service, stationary, solved, stintLaps, need }) => {
                const toggle = (field: keyof Service) =>
                  setServices({ ...services, [key]: { ...service, [field]: !service[field] } })
                const laps = solved ? solved.fuel / p.perLap : null
                const short = laps !== null && laps + 0.5 < stintLaps
                return (
                  <tr key={key}>
                    <td>
                      P{stop.index} <small>v. {stop.inLap ?? "?"}→{stop.outLap}</small>
                    </td>
                    <td>{stop.pitLane === null ? "–" : `${secs(stop.pitLane, 1)} s`}</td>
                    <td>
                      {stationary === null ? "–" : `${secs(Math.max(0, stationary), 1)} s`}
                      {stationary !== null && stationary <= p.minStop + 0.5 && <small> mín.</small>}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        className="compare-check"
                        checked={service.driver}
                        onChange={() => toggle("driver")}
                        aria-label={`Cambio de piloto en la parada ${stop.index}`}
                      />
                      {stop.driverChange && <small> relevo</small>}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        className="compare-check"
                        checked={service.tyres}
                        onChange={() => toggle("tyres")}
                        aria-label={`Cambio de neumáticos en la parada ${stop.index}`}
                      />
                    </td>
                    <td className="loss-cell">
                      {solved === null
                        ? "–"
                        : `${solved.upperBound ? "≤ " : ""}${secs(solved.fuel, 1)} ${unit}`}
                      {solved?.capped && <small> (lleno)</small>}
                    </td>
                    <td>{laps === null ? "–" : `${secs(laps, 1)} v`}</td>
                    <td className={short ? "slope-up" : ""}>
                      {stintLaps} v <small>({secs(need, 1)} {unit})</small>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="chart-note">
        «≤» = cota superior: la parada duró el tiempo mínimo, o el cambio de piloto en paralelo
        tapa al repostaje. En rojo, stints más largos de lo que daría el combustible calculado
        (revisa caudal, tránsito o si hubo cambio de neumáticos). Neumáticos: los datos no lo dicen;
        márcalo tú.
      </p>

      <h3 className="fuel-subtitle">Coste de la parada por tipo de servicio</h3>
      <div className="fuel-scenarios">
        {scenarios.map(({ name, detail, r }) => (
          <div className="fuel-scenario" key={name}>
            <div className="fuel-scenario-head">
              <strong>{name}</strong>
              <small>{detail}</small>
            </div>
            <div className="fuel-bar" aria-hidden="true">
              <i className="seg-transit" style={{ width: `${(p.transit / scale) * 100}%` }} />
              <i className="seg-fuel" style={{ width: `${(r.refuel / scale) * 100}%` }} />
              <i className="seg-driver" style={{ width: `${(r.driverExtra / scale) * 100}%` }} />
              <i className="seg-tyres" style={{ width: `${(r.tyres / scale) * 100}%` }} />
              <i className="seg-pad" style={{ width: `${(r.padding / scale) * 100}%` }} />
            </div>
            <div className="fuel-scenario-total">
              <strong>{secs(r.total, 1)} s</strong>
              <small>
                parado {secs(r.stationary, 1)} s
                {r.total !== splash ? ` · +${secs(r.total - splash, 1)} s vs splash` : ""}
              </small>
            </div>
          </div>
        ))}
      </div>
      <div className="legend fuel-legend">
        <span><i className="bar-key seg-transit" /> Tránsito pit lane</span>
        <span><i className="bar-key seg-fuel" /> Repostaje</span>
        <span><i className="bar-key seg-driver" /> Piloto (lo que no se solapa)</span>
        <span><i className="bar-key seg-tyres" /> Neumáticos</span>
        <span><i className="bar-key seg-pad" /> Espera hasta el mínimo</span>
      </div>
      <p className="chart-note">
        Servicio completo con el depósito lleno ({secs(fullFuel, 0)} {unit}). Con «% energía virtual»
        el cálculo es el mismo: caudal en %/s y consumo en % por vuelta.
      </p>
    </article>
  )
}
