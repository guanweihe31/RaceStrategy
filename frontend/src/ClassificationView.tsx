// Clasificación por horas de un evento (p. ej. las 24 fotos de las 24 Horas de Le Mans):
// tabla de la clase a la hora elegida, posición en clase hora a hora y diferencia con el
// ritmo del líder de la clase.

import { useEffect, useMemo, useState } from "react"
import { api, formatSigned, useApi, type ClassificationCar, type ClassificationSnapshot } from "./api"
import { CarChips, useCarPicker } from "./carPicker"
import { carColor, gapTick, secs } from "./chartUtils"
import { TraceChart, type TraceLine } from "./TraceChart"

function classGap(snap: ClassificationSnapshot, leader: ClassificationSnapshot | undefined): string {
  if (!leader || snap.classPosition === 1) return "—"
  if (snap.laps !== null && leader.laps !== null && snap.laps < leader.laps) {
    const down = leader.laps - snap.laps
    return `+${down} ${down === 1 ? "vuelta" : "vueltas"}`
  }
  if (snap.totalTime === null || leader.totalTime === null) return "–"
  return `${formatSigned(snap.totalTime - leader.totalTime)} s`
}

export function ClassificationView({ event, onBack }: { event: string; onBack: () => void }) {
  const data = useApi(() => api.classification(event), [event])
  const [category, setCategory] = useState<string | null>(null)
  const [hour, setHour] = useState<number | null>(null)

  useEffect(() => {
    if (!data.data) return
    setCategory((c) => c ?? data.data!.categories[0]?.id ?? "")
    setHour((h) => h ?? data.data!.hours[data.data!.hours.length - 1] ?? null)
  }, [data.data])

  const cars = useMemo<ClassificationCar[]>(() => {
    if (!data.data) return []
    const list = data.data.cars.filter((c) => !category || c.category === category)
    const last = (c: ClassificationCar) => c.snapshots[c.snapshots.length - 1]?.classPosition ?? 999
    return [...list].sort((a, b) => last(a) - last(b))
  }, [data.data, category])
  const order = cars.map((c) => c.number)
  const teams = new Map(cars.map((c) => [c.number, c.team]))
  const picker = useCarPicker(order, [], 10)
  const resetPicker = picker.top
  // al cambiar de clase se vuelve a los 10 primeros
  useEffect(() => resetPicker(), [category]) // eslint-disable-line react-hooks/exhaustive-deps

  if (data.error)
    return (
      <div className="classification">
        <p className="chart-empty panel">{data.error}</p>
        <button type="button" className="chip ghost" onClick={onBack}>
          ← Volver
        </button>
      </div>
    )
  if (!data.data || hour === null) return <p className="chart-empty">Cargando clasificación…</p>

  const { hours, categories, eventName, notices } = data.data
  const maxHour = hours[hours.length - 1]
  const at = (c: ClassificationCar) => c.snapshots.find((s) => s.hour === hour)
  const standing = cars
    .map((c) => ({ car: c, snap: at(c) }))
    .filter((r): r is { car: ClassificationCar; snap: ClassificationSnapshot } => !!r.snap)
    .sort((a, b) => a.snap.classPosition - b.snap.classPosition)
  const leader = standing[0]?.snap

  const lines = (value: (s: ClassificationSnapshot) => number | null): TraceLine[] =>
    picker.visible.map((number) => {
      const car = cars.find((c) => c.number === number)!
      return {
        id: number,
        color: carColor(order, number),
        points: car.snapshots.flatMap((s) => {
          const y = value(s)
          return y === null ? [] : [{ x: s.hour, y }]
        }),
      }
    })

  const tooltip = (h: number, describe: (s: ClassificationSnapshot) => string) => {
    const rows = picker.visible
      .map((number) => ({ number, snap: cars.find((c) => c.number === number)?.snapshots.find((s) => s.hour === h) }))
      .filter((r): r is { number: string; snap: ClassificationSnapshot } => !!r.snap)
      .sort((a, b) => a.snap.classPosition - b.snap.classPosition)
    if (!rows.length) return null
    return (
      <>
        <b>Hora {h}</b>
        {rows.slice(0, 14).map(({ number, snap }) => (
          <span key={number} className="gap-row">
            <i style={{ background: carColor(order, number) }} />#{number}
            <em>{describe(snap)}</em>
          </span>
        ))}
      </>
    )
  }

  return (
    <div className="classification">
      <section className="dashboard-heading">
        <div>
          <div className="eyebrow">
            <span /> CLASIFICACIÓN POR HORAS
          </div>
          <div className="title-row">
            <h1>{eventName}</h1>
            <span className="sample-badge">{hours.length} horas</span>
          </div>
        </div>
        <div className="heading-actions">
          <button type="button" onClick={onBack}>
            ← Volver
          </button>
        </div>
      </section>

      {notices.length > 0 && (
        <div className="insight-bar">
          <span>i</span>
          <p>{notices.join(" ")}</p>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Clase">
        {categories.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={category === c.id}
            className={category === c.id ? "active" : ""}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <article className="panel race-panel">
        <div className="panel-heading race-heading">
          <div>
            <h2>Posición en clase hora a hora</h2>
            <p>Cada punto es la posición al final de esa hora de carrera.</p>
          </div>
        </div>
        <CarChips order={order} teams={teams} picker={picker} marked={order[0] ?? ""} markLabel="1º" />
        <TraceChart
          lines={lines((s) => s.classPosition)}
          xMax={maxHour}
          resetKey={`${category}|pos`}
          ariaLabel="Posición en clase de cada coche al final de cada hora"
          xLabel="hora de carrera"
          zeroLabel=""
          formatTick={(t) => `P${t}`}
          includeZero={false}
          integerTicks
          bottomNote=""
          tooltip={(h) => tooltip(h, (s) => `P${s.classPosition} · ${s.laps ?? "–"} v`)}
        />
      </article>

      <article className="panel race-panel">
        <div className="panel-heading race-heading">
          <div>
            <h2>Diferencia con el ritmo del líder de la clase</h2>
            <p>
              Tiempo total − vueltas × ritmo medio del líder de la clase a esa hora. Sirve también
              para coches doblados: cada vuelta perdida aparece como su tiempo.
            </p>
          </div>
        </div>
        <TraceChart
          lines={lines((s) => s.leaderDelta)}
          xMax={maxHour}
          resetKey={`${category}|delta`}
          ariaLabel="Diferencia de cada coche con el ritmo medio del líder de su clase"
          xLabel="hora de carrera"
          zeroLabel="líder"
          formatTick={gapTick}
          tooltip={(h) => tooltip(h, (s) => (s.leaderDelta === null ? "–" : `${formatSigned(s.leaderDelta)} s`))}
        />
      </article>

      <article className="panel race-panel">
        <div className="panel-heading race-heading">
          <div>
            <h2>Clasificación al final de la hora {hour}</h2>
            <p>Diferencia con el líder de la clase; vuelta rápida hasta esa hora.</p>
          </div>
          <label className="car-select race-range">
            <span>HORA</span>
            <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {hours.map((h) => (
                <option key={h} value={h}>
                  Hora {h}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-scroll stint-table race-table">
          <table>
            <caption className="sr-only">Clasificación de la clase a la hora {hour}</caption>
            <thead>
              <tr>
                <th scope="col">Clase</th>
                <th scope="col">General</th>
                <th scope="col">Coche</th>
                <th scope="col">Pilotos</th>
                <th scope="col">Vueltas</th>
                <th scope="col">Diferencia</th>
                <th scope="col">Vuelta rápida</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {standing.map(({ car, snap }) => (
                <tr key={car.number}>
                  <td>P{snap.classPosition}</td>
                  <td>{snap.position ?? "–"}</td>
                  <td>
                    <i className="dot" style={{ background: carColor(order, car.number) }} />#{car.number}{" "}
                    {car.team} <small>{car.vehicle}</small>
                  </td>
                  <td>
                    <small>{car.drivers.join(" · ")}</small>
                  </td>
                  <td>{snap.laps ?? "–"}</td>
                  <td>{classGap(snap, leader)}</td>
                  <td>
                    {snap.bestLap.text}
                    {snap.bestLapNumber !== null && <small> (v. {snap.bestLapNumber})</small>}
                  </td>
                  <td>
                    <small>{snap.status}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="chart-note">
          Estos archivos solo traen una foto por hora: para ritmo por vuelta, stints, tráfico o
          paradas hacen falta los archivos de vueltas (…_Analysis_….CSV). Tiempo de carrera del
          líder de la clase al final de la hora {hour}: {secs(leader?.totalTime ?? null, 0)} s.
        </p>
      </article>
    </div>
  )
}
