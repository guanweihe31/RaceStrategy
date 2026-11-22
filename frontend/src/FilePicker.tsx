// Ventana para elegir qué archivos analizar: todos los CSV/Excel de la carpeta de datos,
// agrupados por evento, con su tipo. Los de vueltas (Analysis) se pueden combinar; las
// clasificaciones por horas abren su propia vista.

import { useMemo, useState } from "react"
import { selectionIds, type ClassificationEvent, type DataFile } from "./api"

const KIND_LABEL: Record<DataFile["kind"], string> = {
  analysis: "Vueltas",
  classification: "Clasificación",
  unknown: "Formato desconocido",
}

export function FilePicker({
  files,
  classifications,
  current,
  dataDir,
  onAnalyze,
  onClassification,
  onClose,
}: {
  files: DataFile[]
  classifications: ClassificationEvent[]
  current: string | null
  dataDir: string
  onAnalyze: (ids: string[]) => void
  onClassification: (event: string) => void
  onClose: () => void
}) {
  const analysisIds = useMemo(
    () => new Set(files.filter((f) => f.kind === "analysis").map((f) => f.id)),
    [files],
  )
  const [checked, setChecked] = useState<Set<string>>(() => {
    const ids = current ? (selectionIds(current) ?? [current]) : []
    return new Set(ids.filter((id) => analysisIds.has(id)))
  })
  const events = useMemo(() => {
    const out = new Map<string, { name: string; files: DataFile[] }>()
    for (const f of files) {
      const group = out.get(f.event) ?? { name: f.eventName, files: [] }
      group.files.push(f)
      out.set(f.event, group)
    }
    // orden natural: "Hour 2" antes que "Hour 10"
    const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
    out.forEach((group) => group.files.sort((a, b) => natural.compare(a.name, b.name)))
    return [...out.entries()]
  }, [files])

  const toggle = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }
  const setEvent = (event: string, on: boolean) => {
    const next = new Set(checked)
    for (const f of files) if (f.event === event && f.kind === "analysis") on ? next.add(f.id) : next.delete(f.id)
    setChecked(next)
  }
  // se mantiene el orden de la lista (por evento y nombre)
  const picked = files.filter((f) => checked.has(f.id)).map((f) => f.id)

  return (
    <div className="picker-backdrop" role="dialog" aria-modal="true" aria-label="Elegir archivos" onClick={onClose}>
      <div className="picker" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <div>
            <h2>Elegir archivos</h2>
            <p>
              Marca uno o varios archivos de vueltas para analizarlos juntos. Carpeta de datos:{" "}
              <code>{dataDir}</code>
            </p>
          </div>
          <button type="button" className="chip ghost" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="picker-body">
          {events.length === 0 && <p className="chart-empty">No hay archivos en la carpeta de datos.</p>}
          {events.map(([event, group]) => {
            const lapFiles = group.files.filter((f) => f.kind === "analysis")
            const allOn = lapFiles.length > 0 && lapFiles.every((f) => checked.has(f.id))
            const hourly = classifications.find((c) => c.event === event)
            return (
              <section className="picker-event" key={event}>
                <div className="picker-event-head">
                  <strong>{group.name}</strong>
                  <span>
                    {lapFiles.length > 0 && (
                      <button type="button" className="chip ghost" onClick={() => setEvent(event, !allOn)}>
                        {allOn ? "Quitar todos" : `Todos los de vueltas (${lapFiles.length})`}
                      </button>
                    )}
                    {hourly && (
                      <button type="button" className="chip on" onClick={() => onClassification(event)}>
                        Clasificación por horas ({hourly.files}) →
                      </button>
                    )}
                  </span>
                </div>
                <ul>
                  {group.files.map((f) => {
                    const usable = f.kind === "analysis"
                    return (
                      <li key={f.id} className={usable ? "" : "disabled"}>
                        <label>
                          <input
                            type="checkbox"
                            className="compare-check"
                            checked={checked.has(f.id)}
                            disabled={!usable}
                            onChange={() => toggle(f.id)}
                          />
                          <span className="picker-name">{f.name}</span>
                          <span className={`kind-badge kind-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                          <small>
                            {f.categories?.join(" · ") ?? ""}
                            {f.categories?.length ? " · " : ""}
                            {f.sizeKb} KB
                          </small>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>

        <div className="picker-foot">
          <small>
            Los de «Clasificación» (p. ej. por horas) no tienen vueltas: se ven en su propia vista.
            Para añadir archivos, cópialos en una carpeta por evento dentro de la carpeta de datos y
            recarga la página.
          </small>
          <div>
            <button type="button" className="chip ghost" onClick={() => setChecked(new Set())} disabled={!picked.length}>
              Ninguno
            </button>
            <button
              type="button"
              className="primary-button picker-go"
              disabled={!picked.length}
              onClick={() => onAnalyze(picked)}
            >
              Analizar {picked.length > 1 ? `${picked.length} archivos juntos` : picked.length ? "este archivo" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
