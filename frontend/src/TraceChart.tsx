// Gráfica de trazas por vuelta (gap a referencia, distancia de carrera...): una línea por
// coche, franjas verticales (FCY, paradas), línea de cero, cursor con tooltip y zoom de
// caja estilo MoTeC (botón derecho).

import { useId, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { useBoxZoom, ZOOM_HINT, type PlotFrame } from "./chartZoom"
import { ticks } from "./chartUtils"

export type TraceLine = {
  id: string
  color: string
  emphasis?: boolean
  dim?: boolean
  points: { x: number; y: number }[]
  rings?: { x: number; y: number }[] // p. ej. vueltas de salida de boxes
}

export type TraceBand = {
  from: number // en unidades X (los extremos se amplían media vuelta)
  to: number
  fill: string
  label: string
  labelColor: string
  bottom?: boolean // etiqueta abajo en vez de arriba
}

export function TraceChart({
  lines,
  bands = [],
  xMax,
  resetKey,
  ariaLabel,
  xLabel,
  zeroLabel,
  formatTick,
  limit = null,
  tooltip,
  includeZero = true,
  integerTicks = false,
  bottomNote = "por detrás ↓",
}: {
  lines: TraceLine[]
  bands?: TraceBand[]
  xMax: number
  resetKey: string
  ariaLabel: string
  xLabel: string
  zeroLabel: string
  formatTick: (t: number) => string
  limit?: number | null // recorta el eje Y a ±limit (s)
  tooltip: (x: number) => ReactNode
  includeZero?: boolean // false: el eje Y se ajusta a los datos (p. ej. posiciones 1..N)
  integerTicks?: boolean // solo marcas enteras positivas en Y (posiciones)
  bottomNote?: string
}) {
  const zoom = useBoxZoom(resetKey)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const clipId = `trace-${useId().replace(/:/g, "")}`

  const width = 900
  const height = 360
  const pad = { left: 70, right: 18, top: 22, bottom: 32 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const box = zoom.view
  const xMin = box ? box.x0 : 0.5
  const xTop = box ? box.x1 : xMax + 0.5
  const values = lines.flatMap((l) =>
    l.points.filter((p) => p.x >= xMin && p.x <= xTop).map((p) => p.y),
  )
  let yMin = includeZero ? Math.min(0, ...values) : Math.min(...values)
  let yMax = includeZero ? Math.max(0, ...values) : Math.max(...values)
  if (!values.length) {
    yMin = 0
    yMax = 1
  }
  if (limit !== null) {
    yMin = Math.max(yMin, -limit)
    yMax = Math.min(yMax, limit)
  }
  const margin = (yMax - yMin || 10) * 0.05
  yMin -= margin
  yMax += margin
  if (box && box.y0 !== null && box.y1 !== null) {
    yMin = box.y0
    yMax = box.y1
  }

  const sx = (x: number) => pad.left + ((x - xMin) / (xTop - xMin)) * plotW
  const sy = (y: number) => pad.top + ((y - yMin) / (yMax - yMin)) * plotH // positivo = abajo
  const frame: PlotFrame = {
    width,
    height,
    left: pad.left,
    top: pad.top,
    plotW,
    plotH,
    toX: (px) => xMin + ((px - pad.left) / plotW) * (xTop - xMin),
    toY: (py) => yMin + ((py - pad.top) / plotH) * (yMax - yMin),
  }
  const yTicks = ticks(yMin, yMax, 6).filter((t) => !integerTicks || (Number.isInteger(t) && t > 0))
  if (integerTicks && yMin <= 1 && !yTicks.includes(1)) yTicks.unshift(1) // P1 siempre visible
  const xTicks = ticks(Math.ceil(xMin), Math.floor(xTop), 14).filter(
    (t) => Number.isInteger(t) && sx(t) < width - pad.right - 100,
  )

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (zoom.onPointerMove(event, frame)) {
      setHoverX(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const x = Math.round(frame.toX(((event.clientX - rect.left) / rect.width) * width))
    setHoverX(x >= Math.ceil(xMin) && x <= Math.floor(xTop) ? x : null)
  }

  const tip = hoverX === null ? null : tooltip(hoverX)

  return (
    <>
      <div className="chart-tools trace-tools" role="group" aria-label="Zoom">
        <button type="button" onClick={zoom.back} disabled={!zoom.depth}>
          ← Zoom anterior
        </button>
        <button type="button" onClick={zoom.reset} disabled={!zoom.depth}>
          Ver todo
        </button>
        <span className="chart-tools-hint">{ZOOM_HINT}</span>
      </div>
      <div className="chart-wrap">
        <svg
          className="line-chart gap-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onPointerDown={(event) => zoom.onPointerDown(event, frame) && setHoverX(null)}
          onPointerMove={onMove}
          onPointerUp={(event) => zoom.onPointerUp(event, frame)}
          onPointerCancel={(event) => zoom.onPointerUp(event, frame)}
          onPointerLeave={() => setHoverX(null)}
          onDoubleClick={zoom.reset}
          onContextMenu={zoom.onContextMenu}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.left} y={pad.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          <g clipPath={`url(#${clipId})`}>
            {bands.map((b, i) => (
              <rect
                key={`band-${i}`}
                x={sx(b.from - 0.5)}
                y={pad.top}
                width={Math.max(2, sx(b.to + 0.5) - sx(b.from - 0.5))}
                height={plotH}
                fill={b.fill}
              />
            ))}
          </g>
          {bands.map((b, i) => {
            const x = sx(b.from - 0.5)
            if (x < pad.left || x > width - pad.right) return null
            return (
              <text
                key={`band-label-${i}`}
                x={x + 2}
                y={b.bottom ? height - pad.bottom - 6 : pad.top - 6}
                fill={b.labelColor}
                fontSize="10"
              >
                {b.label}
              </text>
            )
          })}

          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={sy(t)}
                y2={sy(t)}
                stroke={t === 0 ? "#E6EDF5" : "#203044"}
                strokeOpacity={t === 0 ? 0.6 : 1}
                strokeDasharray={t === 0 ? "6 4" : undefined}
              />
              <text x={pad.left - 8} y={sy(t) + 4} textAnchor="end" fill="#8da0b4" fontSize="11">
                {t === 0 ? zeroLabel : formatTick(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={height - 10} textAnchor="middle" fill="#8da0b4" fontSize="11">
              {t}
            </text>
          ))}
          <text x={width - pad.right} y={height - 10} textAnchor="end" fill="#62758a" fontSize="10">
            {xLabel}
          </text>
          <text x={pad.left + 4} y={height - pad.bottom - 6} fill="#62758a" fontSize="10">
            {bottomNote}
          </text>

          <g clipPath={`url(#${clipId})`}>
            {lines.map((line) => (
              <g key={line.id}>
                <polyline
                  points={line.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={line.emphasis ? 3 : 1.6}
                  strokeOpacity={line.dim ? 0.55 : 0.95}
                  strokeLinejoin="round"
                />
                {(line.rings ?? []).map((p) => (
                  <circle
                    key={`r${p.x}`}
                    cx={sx(p.x)}
                    cy={sy(p.y)}
                    r={3.6}
                    fill="#0d1621"
                    stroke={line.color}
                    strokeWidth={1.6}
                  />
                ))}
              </g>
            ))}
          </g>

          {hoverX !== null && (
            <line
              x1={sx(hoverX)}
              x2={sx(hoverX)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke="#E6EDF5"
              strokeOpacity="0.35"
            />
          )}
          {zoom.selection && <rect className="zoom-box" {...zoom.selection} />}
        </svg>

        {hoverX !== null && tip && (
          <div
            className="chart-tooltip gap-tooltip"
            style={{ left: `${Math.min(80, Math.max(20, (sx(hoverX) / width) * 100))}%`, top: "8%" }}
          >
            {tip}
          </div>
        )}
      </div>
    </>
  )
}
