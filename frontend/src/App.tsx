import {
  Component,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  api,
  formatLapTime,
  formatSeconds,
  formatSigned,
  setMsSeparator,
  timeFormatLabel,
  useApi,
  type CarData,
  type CategoryData,
  type Metric,
  type Overview,
  type PitGroup,
  type PitStop,
  type RankingRow,
  type SessionInfo,
  selectionId,
  selectionIds,
  type ClassificationEvent,
} from "./api"
import { ClassificationView } from "./ClassificationView"
import { FilePicker } from "./FilePicker"
import { useBoxZoom, ZOOM_HINT, type PlotFrame } from "./chartZoom"
import { RaceAnalysisSection } from "./RaceAnalysis"
import { loadRaceAnalysis, type AnalysisLap } from "./raceAnalysisData"

// ---------------------------------------------------------------------------
// Textos e imágenes estáticos (lo demás viene del backend)
// ---------------------------------------------------------------------------
const photos: Record<string, string> = {
  hypercar:
    "https://images.unsplash.com/photo-1784654682177-e312b0ed52fa?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&q=85&w=1400",
  lmgt3:
    "https://images.unsplash.com/photo-1786640779712-8b9a6d93ec1b?crop=entropy&cs=tinysrgb&fit=crop&fm=jpg&q=85&w=1400",
}

const categoryCopy: Record<string, { description: string; badge: string }> = {
  HYPERCAR: {
    description:
      "Compara prototipos, detecta la tendencia y encuentra el ritmo más competitivo.",
    badge: "HYP / PROTOTIPOS",
  },
  LMGT3: {
    description:
      "Evalúa la consistencia de los GT y compara el rendimiento de los pilotos en un mismo coche.",
    badge: "GT3 / GRAN TURISMO",
  },
  LMP2: {
    description:
      "Compara los LMP2: ritmo, regularidad y diferencias entre los pilotos de un mismo coche.",
    badge: "LMP2 / PROTOTIPOS",
  },
}
const fallbackCopy = {
  description: "Analiza el ritmo de cada coche y la diferencia entre sus pilotos.",
  badge: "WEC",
}

const METRIC_TABS: { key: Metric; label: string; title: string }[] = [
  { key: "lap", label: "Resumen de ritmo", title: "Mejor vuelta" },
  { key: "s1", label: "Sector 1", title: "Mejor sector 1" },
  { key: "s2", label: "Sector 2", title: "Mejor sector 2" },
  { key: "s3", label: "Sector 3", title: "Mejor sector 3" },
]

const SLOW_OPTIONS = [105, 107, 110, 115, 120]

// Color + forma: la forma identifica la serie aunque no se distingan los colores.
const PALETTE = ["#2F80FF", "#42D6FF", "#9D86FF", "#7B91AD", "#FFB454", "#5BD19F"]
type Shape = "circle" | "diamond" | "square" | "triangle" | "cross" | "ring"
const SHAPES: Shape[] = ["circle", "diamond", "square", "triangle", "circle", "diamond"]
const DRIVER_PALETTE = ["#D4F25C", "#5FD3E8", "#B79CFF", "#FFB454", "#5BD19F", "#FF8FA3"]
const EXCLUDED_COLOR = "#8392A5"
const PIT_LINE_COLOR = "#E6EDF5"

type Mode = "ritmo" | "todas"

// ---------------------------------------------------------------------------
// Iconos y marca
// ---------------------------------------------------------------------------
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  if (name === "chart")
    return (
      <svg {...common}>
        <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />
      </svg>
    )
  if (name === "grid")
    return (
      <svg {...common}>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </svg>
    )
  if (name === "download")
    return (
      <svg {...common}>
        <path d="M12 3v12m-4-4 4 4 4-4M5 20h14" />
      </svg>
    )
  if (name === "chevron")
    return (
      <svg {...common}>
        <path d="m9 18 6-6-6-6" />
      </svg>
    )
  if (name === "flag")
    return (
      <svg {...common}>
        <path d="M5 21V4m0 1c5-3 8 3 14 0v9c-6 3-9-3-14 0" />
      </svg>
    )
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  )
}

function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button className="logo" onClick={onClick} aria-label="Volver al inicio">
      <span className="mark">
        <i />
        <i />
        <i />
      </span>
      <span>RACE STRATEGY</span>
      <small>BY BG</small>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Gráfica de líneas con tooltip al pasar el ratón
// ---------------------------------------------------------------------------
type Point = { x: number; y: number; who: string; note?: string; best?: boolean }
type Series = {
  id: string
  label: string
  color: string
  shape: Shape
  line: boolean
  dashed?: boolean // línea discontinua que une todos sus puntos (tendencia)
  dash?: string // patrón de trazo (stroke-dasharray) para distinguir series del mismo color
  markers?: boolean // false: solo línea, sin puntos
  scale?: number // tamaño del marcador (1 = normal); p. ej. anillos que resaltan puntos
  points: Point[]
}
// Franja de fondo con una etiqueta (p. ej. un stint) entre dos vueltas.
type Band = { from: number; to: number; label: string; short: string }

function Marker({
  shape,
  x,
  y,
  r,
  color,
}: {
  shape: Shape
  x: number
  y: number
  r: number
  color: string
}) {
  const common = { fill: color, stroke: "#0d1621", strokeWidth: 1 }
  if (shape === "ring")
    return <circle cx={x} cy={y} r={r * 1.15} fill="none" stroke={color} strokeWidth={2} />
  if (shape === "diamond")
    return (
      <polygon
        {...common}
        points={`${x},${y - r * 1.3} ${x + r * 1.3},${y} ${x},${y + r * 1.3} ${x - r * 1.3},${y}`}
      />
    )
  if (shape === "square")
    return <rect {...common} x={x - r} y={y - r} width={r * 2} height={r * 2} />
  if (shape === "triangle")
    return (
      <polygon
        {...common}
        points={`${x},${y - r * 1.3} ${x + r * 1.25},${y + r} ${x - r * 1.25},${y + r}`}
      />
    )
  if (shape === "cross")
    return (
      <g stroke={color} strokeWidth={2} strokeLinecap="round">
        <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} />
        <line x1={x - r} y1={y + r} x2={x + r} y2={y - r} />
      </g>
    )
  return <circle {...common} cx={x} cy={y} r={r} />
}

function Legend({ series, pit = false }: { series: Series[]; pit?: boolean }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.id}>
          <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">
            {s.line && (
              <line
                x1="1"
                y1="6"
                x2="23"
                y2="6"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={s.dash ?? (s.dashed ? "6 4" : undefined)}
              />
            )}
            <Marker shape={s.shape} x={12} y={6} r={3.4} color={s.color} />
          </svg>
          {s.label}
        </span>
      ))}
      {pit && (
        <span>
          <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">
            <line
              x1="12"
              y1="0"
              x2="12"
              y2="12"
              stroke={PIT_LINE_COLOR}
              strokeWidth="2"
              strokeDasharray="3 2"
            />
          </svg>
          Parada en boxes
        </span>
      )}
    </div>
  )
}

function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min
  if (span <= 0) return [min]
  const raw = span / target
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) {
    ticks.push(Number(t.toFixed(6)))
  }
  return ticks
}

// Une solo vueltas consecutivas: donde falta una (boxes, FCY...) la línea se corta.
function segments(points: Point[]): Point[][] {
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const out: Point[][] = []
  let current: Point[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p.x - sorted[i - 1].x !== 1) {
      out.push(current)
      current = []
    }
    current.push(p)
  })
  if (current.length) out.push(current)
  return out
}

// Zoom y desplazamiento vertical (solo las gráficas con `interactiveY`).
const MIN_SPAN = 0.05 // s: zoom máximo (50 ms de rango visible)

type YView = { min: number; max: number }
type Geometry = { height: number; padTop: number; padBottom: number; full: YView; view: YView }

// Mantiene la ventana dentro del rango completo y con un tamaño válido.
function clampView(view: YView, full: YView): YView {
  const fullSpan = full.max - full.min
  const span = Math.min(Math.max(view.max - view.min, Math.min(MIN_SPAN, fullSpan)), fullSpan)
  const min = Math.min(Math.max(view.min, full.min), full.max - span)
  return { min, max: min + span }
}

// Cambia el tamaño de la ventana manteniendo `anchor` en la misma posición de pantalla.
function zoomView(view: YView, full: YView, factor: number, anchor: number): YView {
  const span = view.max - view.min
  const ratio = (anchor - view.min) / span
  const newSpan = span * factor
  const min = anchor - ratio * newSpan
  return clampView({ min, max: min + newSpan }, full)
}

function panView(view: YView, full: YView, delta: number): YView {
  return clampView({ min: view.min + delta, max: view.max + delta }, full)
}

// Valor (segundos) que corresponde a una posición vertical del SVG.
function valueAt(g: Geometry, yUnits: number): number {
  const plotH = g.height - g.padTop - g.padBottom
  return g.view.min + (1 - (yUnits - g.padTop) / plotH) * (g.view.max - g.view.min)
}

function LineChart({
  series,
  compact = false,
  label,
  bands = [],
  pitStops = [],
  interactiveY = false,
  resetKey = "",
  xLabel = "Vuelta",
  wide = false,
}: {
  series: Series[]
  wide?: boolean // gráfica a todo el ancho de la tarjeta: más ancha y con más marcas en X
  compact?: boolean
  label: string
  bands?: Band[]
  pitStops?: PitStop[] // paradas en boxes: línea discontinua vertical con su recuadro
  xLabel?: string // nombre del eje X: "Vuelta" o "Vuelta del stint"
  interactiveY?: boolean // permite moverse y ampliar en el eje Y
  resetKey?: string // al cambiar, vuelve a mostrarse todo el rango
}) {
  const [hover, setHover] = useState<{ s: number; p: number } | null>(null)
  const [hoverPit, setHoverPit] = useState<number | null>(null)
  const [yView, setYView] = useState<YView | null>(null)
  const [dragging, setDragging] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ startY: number; view: YView } | null>(null)
  const geom = useRef<Geometry | null>(null)
  const clipId = `clip-${useId().replace(/:/g, "")}`
  const zoom = useBoxZoom(resetKey)
  const all = series.flatMap((s) => s.points)
  const empty = all.length === 0

  // Al cambiar la selección se vuelve a ver todo el rango.
  useEffect(() => {
    setYView(null)
  }, [resetKey])

  // Ctrl (o ⌘) + rueda: ampliar/reducir alrededor del puntero. Sin Ctrl la rueda
  // sigue desplazando la página.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !interactiveY) return
    const onWheel = (event: WheelEvent) => {
      const g = geom.current
      if (!g || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      if (!rect.height) return
      const anchor = valueAt(g, ((event.clientY - rect.top) / rect.height) * g.height)
      setYView(zoomView(g.view, g.full, event.deltaY < 0 ? 1 / 1.25 : 1.25, anchor))
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [interactiveY, empty])

  if (empty) {
    geom.current = null
    return <p className="chart-empty">No hay vueltas que mostrar con los filtros actuales.</p>
  }

  const width = wide ? 900 : 620
  const height = compact ? 230 : wide ? 320 : 290
  const pad = { left: 74, right: 18, top: 14, bottom: 30 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const xs = [...all.map((p) => p.x), ...bands.flatMap((b) => [b.from - 0.5, b.to + 0.5])]
  // Zoom de caja (botón derecho): fija el rango X y, si la caja tenía altura, también el Y.
  const box = zoom.view
  const minX = box ? box.x0 : Math.min(...xs)
  const maxX = box ? box.x1 : Math.max(...xs)
  const inRange = all.filter((p) => p.x >= minX - 0.5 && p.x <= maxX + 0.5)
  const ys = (inRange.length ? inRange : all).map((p) => p.y)
  const rawMinY = Math.min(...ys)
  const rawMaxY = Math.max(...ys)
  const margin = (rawMaxY - rawMinY || 1) * 0.08
  const full: YView = { min: rawMinY - margin, max: rawMaxY + margin }
  const view =
    box && box.y0 !== null && box.y1 !== null
      ? { min: box.y0, max: box.y1 }
      : interactiveY && yView
        ? clampView(yView, full)
        : full
  const zoomed = view.max - view.min < full.max - full.min - 1e-9
  const atMaxZoom = view.max - view.min <= MIN_SPAN + 1e-9
  geom.current = { height, padTop: pad.top, padBottom: pad.bottom, full, view }
  const minY = view.min
  const maxY = view.max

  const sx = (x: number) => pad.left + ((x - minX) / (maxX - minX || 1)) * plotW
  const sy = (y: number) => pad.top + (1 - (y - minY) / (maxY - minY)) * plotH
  const visible = (y: number) => y >= minY - 1e-9 && y <= maxY + 1e-9

  // La línea de parada va entre la vuelta de entrada y la de salida; solo se
  // dibujan las que caen dentro del rango del gráfico.
  const pits = pitStops
    .map((stop, index) => ({ stop, index, x: (stop.fromLap + stop.toLap) / 2 }))
    .filter((p) => p.x >= minX && p.x <= maxX)

  const yTicks = niceTicks(minY, maxY, 5)
  const xTicks = niceTicks(minX, maxX, wide ? 14 : 8).filter(Number.isInteger)

  const zoomBy = (factor: number) =>
    setYView(zoomView(view, full, factor, (view.min + view.max) / 2))
  const panBy = (fraction: number) =>
    setYView(panView(view, full, (view.max - view.min) * fraction))

  const frame: PlotFrame = {
    width,
    height,
    left: pad.left,
    top: pad.top,
    plotW,
    plotH,
    toX: (px) => minX + ((px - pad.left) / plotW) * (maxX - minX || 1),
    toY: (py) => maxY - ((py - pad.top) / plotH) * (maxY - minY),
  }
  const resetAll = () => {
    setYView(null)
    zoom.reset()
  }

  // Arrastrar: la gráfica sigue al puntero (botón izquierdo); el derecho es el zoom de caja.
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (zoom.onPointerDown(event, frame)) {
      setHover(null)
      return
    }
    if (!interactiveY || event.button !== 0) return
    dragRef.current = { startY: event.clientY, view }
    setDragging(true)
    setHover(null)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (zoom.onPointerMove(event, frame)) return
    const drag = dragRef.current
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.height) return
    const dyUnits = ((event.clientY - drag.startY) / rect.height) * height
    const delta = (dyUnits / plotH) * (drag.view.max - drag.view.min)
    setYView(panView(drag.view, full, delta))
  }
  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    zoom.onPointerUp(event, frame)
    dragRef.current = null
    setDragging(false)
  }

  const hovered = hover ? series[hover.s]?.points[hover.p] : undefined
  const tooltip = hovered
    ? {
        left: Math.min(88, Math.max(12, (sx(hovered.x) / width) * 100)),
        top: (sy(hovered.y) / height) * 100,
      }
    : null

  const pitHover = hoverPit === null ? undefined : pitStops[hoverPit]
  const pitTooltip = pitHover
    ? {
        left: Math.min(
          88,
          Math.max(12, (sx((pitHover.fromLap + pitHover.toLap) / 2) / width) * 100),
        ),
        top: ((pad.top + 6) / height) * 100,
      }
    : null

  return (
    <>
      {!interactiveY && zoom.depth > 0 && (
        <div className="chart-tools" role="group" aria-label="Zoom">
          <button type="button" onClick={zoom.back}>
            ← Zoom anterior
          </button>
          <button type="button" onClick={resetAll}>
            Ver todo
          </button>
          <span className="chart-tools-hint">{ZOOM_HINT}</span>
        </div>
      )}
      {interactiveY && (
        <div className="chart-tools" role="group" aria-label="Zoom y desplazamiento vertical">
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.5)}
            disabled={atMaxZoom}
            aria-label="Ampliar zona (zoom vertical)"
            title="Ampliar"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.5)}
            disabled={!zoomed}
            aria-label="Reducir zoom vertical"
            title="Reducir"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => panBy(0.25)}
            disabled={!zoomed}
            aria-label="Subir: ver tiempos más lentos"
            title="Subir"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => panBy(-0.25)}
            disabled={!zoomed}
            aria-label="Bajar: ver tiempos más rápidos"
            title="Bajar"
          >
            ↓
          </button>
          <button type="button" onClick={resetAll} disabled={!zoomed && zoom.depth === 0}>
            Ver todo
          </button>
          <span className="chart-tools-hint">
            Arrastra para moverte · Ctrl + rueda para ampliar · {ZOOM_HINT}
          </span>
        </div>
      )}
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          className={`line-chart${interactiveY ? " interactive" : ""}${dragging ? " dragging" : ""}`}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetAll}
          onContextMenu={zoom.onContextMenu}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.left} y={pad.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
          {bands.map((b, i) => {
            const x1 = sx(b.from - 0.5)
            const x2 = sx(b.to + 0.5)
            return (
              <g key={`band-${b.label}`}>
                <rect
                  x={x1}
                  y={pad.top}
                  width={x2 - x1}
                  height={plotH}
                  fill={i % 2 === 0 ? "rgba(66,214,255,0.07)" : "rgba(157,134,255,0.07)"}
                />
                <text
                  x={(x1 + x2) / 2}
                  y={pad.top + 13}
                  textAnchor="middle"
                  fill="#9fb0c2"
                  fontSize="11"
                >
                  {x2 - x1 < 54 ? b.short : b.label}
                </text>
              </g>
            )
          })}
          </g>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={sy(t)}
                y2={sy(t)}
                stroke="#203044"
                strokeWidth="1"
              />
              <text
                x={pad.left - 8}
                y={sy(t) + 4}
                textAnchor="end"
                fill="#8da0b4"
                fontSize="11"
              >
                {formatLapTime(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={`x${t}`}
              x={sx(t)}
              y={height - 8}
              textAnchor="middle"
              fill="#8da0b4"
              fontSize="11"
            >
              {t}
            </text>
          ))}
          <text x={width - pad.right} y={height - 8} textAnchor="end" fill="#62758a" fontSize="10">
            {xLabel.toLowerCase()}
          </text>

          {pits.map(({ index, x }) => (
            <g key={`pit-${index}`} aria-hidden="true">
              <line
                x1={sx(x)}
                x2={sx(x)}
                y1={pad.top}
                y2={pad.top + plotH}
                stroke={PIT_LINE_COLOR}
                strokeWidth={hoverPit === index ? 2.4 : 1.5}
                strokeOpacity={hoverPit === index ? 1 : 0.7}
                strokeDasharray="5 4"
              />
              <text x={sx(x) + 4} y={pad.top + 11} fill="#9fb0c2" fontSize="10">
                P{index + 1}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {series.map(
              (s) =>
                s.line &&
                (s.dashed ? [[...s.points].sort((a, b) => a.x - b.x)] : segments(s.points))
                  .filter((seg) => seg.length > 1)
                  .map((seg, i) => (
                    <polyline
                      key={`${s.id}-line-${i}`}
                      points={seg.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={s.dashed ? 1.6 : 2}
                      strokeDasharray={s.dash ?? (s.dashed ? "6 4" : undefined)}
                      strokeOpacity={s.dashed ? 0.95 : 0.75}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )),
            )}

            {series.map((s, si) =>
              s.markers === false
                ? null
                : s.points.map((p, pi) => {
                    if (!visible(p.y)) return null
                    const isHover = hover?.s === si && hover.p === pi
                    return (
                      <g key={`${s.id}-${p.x}-${pi}`}>
                        {p.best && (
                          <circle
                            cx={sx(p.x)}
                            cy={sy(p.y)}
                            r={8.5}
                            fill="none"
                            stroke="#FFFFFF"
                            strokeWidth="1.6"
                          />
                        )}
                        <Marker
                          shape={s.shape}
                          x={sx(p.x)}
                          y={sy(p.y)}
                          r={(isHover ? 5.4 : 3.6) * (s.scale ?? 1)}
                          color={s.color}
                        />
                        <circle
                          cx={sx(p.x)}
                          cy={sy(p.y)}
                          r={9}
                          fill="transparent"
                          onMouseEnter={() => setHover({ s: si, p: pi })}
                          onMouseLeave={() => setHover(null)}
                        />
                      </g>
                    )
                  }),
            )}
          </g>

          {pits.map(({ index, x }) => (
            <rect
              key={`pit-hit-${index}`}
              x={sx(x) - 5}
              y={pad.top}
              width={10}
              height={plotH}
              fill="transparent"
              style={{ cursor: "help" }}
              onMouseEnter={() => {
                setHoverPit(index)
                setHover(null)
              }}
              onMouseLeave={() => setHoverPit(null)}
            />
          ))}

          {interactiveY && zoomed && (
            <g aria-hidden="true">
              <rect x={width - 11} y={pad.top} width={5} height={plotH} rx={2.5} fill="#182536" />
              <rect
                x={width - 11}
                y={pad.top + (1 - (view.max - full.min) / (full.max - full.min)) * plotH}
                width={5}
                height={((view.max - view.min) / (full.max - full.min)) * plotH}
                rx={2.5}
                fill="#4b6a8c"
              />
            </g>
          )}
          {zoom.selection && <rect className="zoom-box" {...zoom.selection} />}
        </svg>

        {hovered && tooltip && (
          <div
            className={`chart-tooltip ${tooltip.top < 30 ? "below" : ""}`}
            style={{ left: `${tooltip.left}%`, top: `${tooltip.top}%` }}
          >
            <b>
              {xLabel} {hovered.x}
            </b>
            <strong>{formatLapTime(hovered.y)}</strong>
            <span>{hovered.who}</span>
            {hovered.best && <em>Mejor vuelta de la serie</em>}
            {hovered.note && <em>{hovered.note}</em>}
          </div>
        )}

        {pitHover && pitTooltip && (
          <div
            className="chart-tooltip below"
            style={{ left: `${pitTooltip.left}%`, top: `${pitTooltip.top}%` }}
          >
            <b>
              Parada P{(hoverPit ?? 0) + 1} · vueltas {pitHover.fromLap}–{pitHover.toLap}
            </b>
            <strong>{pitHover.pit.seconds === null ? "Sin tiempo" : pitHover.pit.text}</strong>
            <em>Duración en boxes</em>
            {pitHover.driverChange ? (
              <>
                <span>Sale: {pitHover.driverOut}</span>
                <span>Entra: {pitHover.driverIn}</span>
              </>
            ) : (
              <span>Sin relevo: sigue {pitHover.driverOut}</span>
            )}
          </div>
        )}
      </div>
      {!interactiveY && zoom.depth === 0 && <p className="zoom-hint">{ZOOM_HINT}</p>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Construcción de series a partir de los datos del backend
// ---------------------------------------------------------------------------
function markBest(points: Point[]): Point[] {
  if (!points.length) return points
  const best = Math.min(...points.map((p) => p.y))
  return points.map((p) => (p.y === best ? { ...p, best: true } : p))
}

// En la vista de todas las sesiones, dónde se logró una vuelta: su sesión y su nº de vuelta.
function where(l: { session: string; sessionLap: number }): string {
  return `${l.session} · vuelta ${l.sessionLap}`
}

function lapPoints(data: CarData, pace: boolean, overall: boolean, driver?: string): Point[] {
  return data.laps.flatMap((l) =>
    l.seconds === null || l.isPace !== pace || (driver !== undefined && l.driver !== driver)
      ? []
      : [
          {
            x: l.lap,
            y: l.seconds,
            who: l.driver,
            note:
              [overall ? where(l) : "", pace ? "" : l.status].filter(Boolean).join(" · ") ||
              undefined,
          },
        ],
  )
}

// Vueltas excluidas del ritmo, separadas por motivo para no confundirlas:
//  - bajo bandera (FCY, VSC, SC, RF...): el color y la forma de su bandera,
//  - entrada o salida de boxes: un anillo gris azulado,
//  - lentas de verdad (sin bandera): una cruz gris.
const FLAG_INFO: Record<string, { name: string; color: string; shape: Shape }> = {
  FCY: { name: "Full Course Yellow", color: "#FFD60A", shape: "diamond" },
  VSC: { name: "Virtual Safety Car", color: "#FF9F1C", shape: "triangle" },
  SC: { name: "Safety Car", color: "#FF6B35", shape: "square" },
  RF: { name: "Bandera roja", color: "#FF3B3B", shape: "circle" },
}
const PIT_STYLE = { color: "#7B91AD", shape: "ring" as Shape }

function flagInfo(code: string): { name: string; color: string; shape: Shape } {
  return FLAG_INFO[code] ?? { name: `Bandera ${code}`, color: "#C084FC", shape: "circle" }
}

function excludedGroups(
  laps: CarData["laps"],
  x: (l: CarData["laps"][number]) => number,
  context: (l: CarData["laps"][number]) => string[],
): Series[] {
  const groups = new Map<string, { label: string; color: string; shape: Shape; points: Point[] }>()
  for (const l of laps) {
    if (l.isPace || l.seconds === null) continue
    let key: string
    let label: string
    let style: { color: string; shape: Shape }
    let reason: string
    if (l.flag) {
      const info = flagInfo(l.flag)
      key = `flag-${l.flag}`
      label = `${l.flag} · ${info.name}`
      style = info
      reason = [`${info.name} (${l.flag})`, l.pit === "in" ? "entrada a boxes" : l.pit === "out" ? "salida de boxes" : ""]
        .filter(Boolean)
        .join(" · ")
    } else if (l.pit) {
      key = "pit"
      label = "Entrada / salida de boxes"
      style = PIT_STYLE
      reason = l.status
    } else {
      key = "slow"
      label = "Vueltas lentas (sin bandera)"
      style = { color: EXCLUDED_COLOR, shape: "cross" }
      reason = l.status
    }
    const group = groups.get(key) ?? { label, ...style, points: [] }
    group.points.push({
      x: x(l),
      y: l.seconds,
      who: l.driver,
      note: [...context(l), reason].filter(Boolean).join(" · "),
    })
    groups.set(key, group)
  }
  const order = (key: string) => (key.startsWith("flag-") ? 0 : key === "pit" ? 1 : 2)
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([key, g]) => ({
      id: `excluded-${key}`,
      label: g.label,
      color: g.color,
      shape: g.shape,
      line: false,
      points: g.points,
    }))
}

function excludedSeries(data: CarData, mode: Mode, overall: boolean): Series[] {
  if (mode !== "todas") return []
  return excludedGroups(data.laps, (l) => l.lap, (l) => (overall ? [where(l)] : []))
}

function driverSeries(data: CarData, mode: Mode, overall: boolean): Series[] {
  return [
    ...data.drivers.map((driver, i) => ({
      id: driver.name,
      label: driver.name,
      color: DRIVER_PALETTE[i % DRIVER_PALETTE.length],
      shape: SHAPES[i % SHAPES.length],
      line: true,
      points: markBest(lapPoints(data, true, overall, driver.name)),
    })),
    ...excludedSeries(data, mode, overall),
  ]
}

// Superpuesto: cada stint de cada piloto empieza en la vuelta 1 (salida de boxes), de modo
// que los ritmos de los pilotos se ven unos encima de otros. El color y la forma
// identifican al piloto; el trazo, el stint cuando un mismo piloto tiene varios.
const STINT_DASHES = [undefined, "7 4", "2 4", "10 3 2 3"]

function overlaySeries(data: CarData, mode: Mode, overall: boolean): Series[] {
  const out: Series[] = []
  data.drivers.forEach((driver, di) => {
    const color = DRIVER_PALETTE[di % DRIVER_PALETTE.length]
    const shape = SHAPES[di % SHAPES.length]
    const mine = data.laps.filter((l) => l.driver === driver.name)
    const stints = [...new Set(mine.map((l) => l.stint))].sort((a, b) => a - b)
    const bestY = Math.min(
      ...mine.flatMap((l) => (l.isPace && l.seconds !== null ? [l.seconds] : [])),
    )
    stints.forEach((stint, si) => {
      const points: Point[] = mine.flatMap((l) =>
        l.stint !== stint || !l.isPace || l.seconds === null
          ? []
          : [
              {
                x: l.stintLap,
                y: l.seconds,
                who: driver.name,
                note: `${overall ? where(l) : `Vuelta ${l.lap} de carrera`} · Stint ${stint}`,
                best: l.seconds === bestY,
              },
            ],
      )
      if (!points.length) return
      out.push({
        id: `${driver.name}-s${stint}`,
        label: stints.length > 1 ? `${driver.name} · Stint ${stint}` : driver.name,
        color,
        shape,
        line: true,
        dash: STINT_DASHES[si % STINT_DASHES.length],
        points,
      })
    })
  })
  if (mode === "todas")
    out.push(
      ...excludedGroups(
        data.laps,
        (l) => l.stintLap,
        (l) => [overall ? where(l) : `Vuelta ${l.lap} de carrera`, `Stint ${l.stint}`],
      ),
    )
  return out
}

// Coches marcados en la clasificación para comparar su ritmo (máx. 4). Cada uno
// conserva su color y su forma (`slot`) mientras siga seleccionado.
type Selection = { car: string; slot: number }
const MAX_COMPARE = 4

function paceSeries(data: CategoryData, picks: Selection[], overall: boolean): Series[] {
  return picks.flatMap(({ car, slot }) => {
    const item = data.pace.find((p) => p.car === car)
    if (!item) return []
    return [
      {
        id: car,
        label: `#${car} ${item.team}`,
        color: PALETTE[slot % PALETTE.length],
        shape: SHAPES[slot % SHAPES.length],
        line: true,
        points: markBest(
          item.laps.flatMap((l) =>
            l.seconds === null
              ? []
              : [{ x: l.lap, y: l.seconds, who: l.driver, note: overall ? where(l) : undefined }],
          ),
        ),
      },
    ]
  })
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------
function Header({
  categoryLabel,
  onHome,
}: {
  categoryLabel?: string
  onHome?: () => void
}) {
  return (
    <header className="topbar">
      <Logo onClick={onHome} />
      <div className="top-actions">
        {categoryLabel && (
          <span className="breadcrumb">
            Análisis <i>/</i> {categoryLabel}
          </span>
        )}
        <span className="live-pill">
          <i /> SESIÓN IMPORTADA
        </span>
        <span className="avatar">BG</span>
      </div>
    </header>
  )
}

function Footer({ sessionName, eventName }: { sessionName?: string; eventName?: string }) {
  return (
    <footer>
      <span>
        {sessionName
          ? `Datos reales · ${eventName ? `${eventName} · ` : ""}${sessionName}`
          : "Datos reales de sesión"}
      </span>
      <span>WEC · 2026 · BG</span>
    </footer>
  )
}

function Status({
  title,
  detail,
  busy = false,
  children,
}: {
  title: string
  detail?: string
  busy?: boolean
  children?: ReactNode // acciones (p. ej. volver o elegir otros archivos)
}) {
  return (
    <div className="app-shell">
      <Header />
      <main className="status" role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
        {children && <div className="status-actions">{children}</div>}
      </main>
      <Footer />
    </div>
  )
}

function SessionSelect({
  sessions,
  value,
  onChange,
  className,
  category,
  categoryLabel,
}: {
  sessions: SessionInfo[]
  value: string
  onChange: (id: string) => void
  className: string
  category?: string // si se indica, solo se pueden elegir sesiones que tengan esa categoría
  categoryLabel?: string
}) {
  // Evento (carpeta de datos) y, dentro de él, sesión. Con un solo evento no se muestra el primero.
  const current = sessions.find((s) => s.id === value)
  const events = [...new Map(sessions.map((s) => [s.event, s.eventName])).entries()]
  const has = (s: SessionInfo) =>
    category === undefined || s.categories === null || s.categories.includes(category)

  function changeEvent(event: string) {
    const list = sessions.filter((s) => s.event === event)
    const target = list.find((s) => !s.overall && has(s)) ?? list.find(has) ?? list[0]
    if (target) onChange(target.id)
  }

  return (
    <>
      {events.length > 1 && (
        <label className={className}>
          <span className="select-label">Evento</span>
          <select value={current?.event ?? ""} onChange={(event) => changeEvent(event.target.value)}>
            {events.map(([id, name]) => {
              const unavailable = !sessions.some((s) => s.event === id && has(s))
              return (
                <option key={id} value={id} disabled={unavailable}>
                  {name}
                  {unavailable ? ` — sin ${categoryLabel ?? category}` : ""}
                </option>
              )
            })}
          </select>
        </label>
      )}
      <label className={className}>
        <span className="select-label">Sesión</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {sessions
            .filter((s) => s.event === current?.event)
            .map((s) => {
              const unavailable = !has(s)
              return (
                <option key={s.id} value={s.id} disabled={unavailable}>
                  {s.name}
                  {unavailable ? ` — sin ${categoryLabel ?? category}` : ""}
                </option>
              )
            })}
        </select>
      </label>
    </>
  )
}

function Landing({
  overview,
  sessions,
  sessionId,
  onSession,
  onSelect,
  onPickFiles,
  classifications,
  onClassification,
}: {
  overview: Overview
  sessions: SessionInfo[]
  sessionId: string
  onSession: (id: string) => void
  onSelect: (category: string) => void
  onPickFiles: () => void
  classifications: ClassificationEvent[]
  onClassification: (event: string) => void
}) {
  return (
    <div className="app-shell landing-shell">
      <Header />
      <main className="landing">
        <div className="eyebrow">
          <span /> WEC / CENTRO DE ANÁLISIS
        </div>
        <h1>Cada vuelta cuenta.</h1>
        <p className="intro">
          Selecciona una categoría. Descubre el ritmo de cada coche y lo que
          marca la diferencia entre sus pilotos.
        </p>
        <div className="select-group">
          <SessionSelect
            className="session-select"
            sessions={sessions}
            value={sessionId}
            onChange={onSession}
          />
          <button type="button" className="pick-files" onClick={onPickFiles}>
            Elegir archivos…
          </button>
        </div>
        {classifications.length > 0 && (
          <div className="hourly-strip">
            {classifications.map((c) => (
              <button type="button" key={c.event} onClick={() => onClassification(c.event)}>
                <span className="event-icon">
                  <Icon name="flag" />
                </span>
                <span>
                  <small>CLASIFICACIÓN POR HORAS</small>
                  <strong>{c.eventName}</strong>
                </span>
                <b>{c.files} archivos →</b>
              </button>
            ))}
          </div>
        )}
        <div className="category-grid">
          {overview.categories.map((category) => {
            const copy = categoryCopy[category.id] ?? fallbackCopy
            return (
              <article className="category-card" key={category.id}>
                <div className="category-image">
                  <img
                    src={photos[category.id.toLowerCase()] ?? photos.hypercar}
                    alt={`Coche de competición de la categoría ${category.label}`}
                  />
                  <div className="image-shade" />
                  <span className="category-tag">{copy.badge}</span>
                  <div className="image-title">
                    <h2>{category.label}</h2>
                    <span>WEC 2026</span>
                  </div>
                </div>
                <div className="category-copy">
                  <p>{copy.description}</p>
                  <div className="category-stats">
                    {category.cars} coches · {category.drivers} pilotos · mejor
                    vuelta {category.bestLap.text}
                    {overview.overall ? ` (${category.bestLap.session})` : ""}
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => onSelect(category.id)}
                  >
                    Analizar {category.label}
                    <Icon name="chevron" size={16} />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
        <div className="event-strip">
          <span className="event-icon">
            <Icon name="flag" />
          </span>
          <div>
            <small>SESIÓN CARGADA</small>
            <strong>{overview.session.name}</strong>
          </div>
          <div className="event-meta">
            <span>{overview.laps.toLocaleString("es-ES")} vueltas</span>
            <b>
              {overview.overall
                ? `${overview.sessionCount} sesiones`
                : `${overview.clockStart} – ${overview.clockEnd}`}
            </b>
          </div>
        </div>
      </main>
      <Footer sessionName={overview.session.name} eventName={overview.session.eventName} />
    </div>
  )
}

function MetricCard({
  label,
  value,
  note,
  detail,
  accent,
}: {
  label: string
  value: string
  note: string
  detail: string
  accent?: boolean
}) {
  return (
    <div className={`metric-card ${accent ? "metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small className="metric-note">{note}</small>
      <small className="metric-detail">{detail}</small>
    </div>
  )
}

// Evolución del ritmo de un piloto durante sus stints (vuelta en X, tiempo en Y).
// Filtros del gráfico de stint: qué vueltas no de ritmo se muestran.
type LapKind = "neutralized" | "in" | "out" | "slow"
const LAP_KIND_LABELS: Record<LapKind, string> = {
  in: "Entradas a boxes",
  out: "Salidas de boxes",
  neutralized: "FCY / Safety Car",
  slow: "Lentas (sin bandera)",
}
const IN_LAP_STYLE = { color: "#7B91AD", shape: "ring" as Shape }
const OUT_LAP_STYLE = { color: "#A9BCD2", shape: "triangle" as Shape }
const TRAFFIC_COLOR = "#FF8A3D"

function StintPanel({
  data,
  overall,
  analysisLaps,
}: {
  data: CarData
  overall: boolean
  // vueltas del coche según /analysis/laps (tráfico, FLAG_AT_FL, PIT_TIME); sin ellas
  // se usan los campos de CarLap y no se puede resaltar el tráfico
  analysisLaps?: AnalysisLap[]
}) {
  const [driver, setDriver] = useState(data.drivers[0]?.name ?? "")
  const [showTrend, setShowTrend] = useState(false)
  const [shown, setShown] = useState<Record<LapKind, boolean>>({
    in: false,
    out: false,
    neutralized: false,
    slow: false,
  })
  const [highlightTraffic, setHighlightTraffic] = useState(true)
  const hasTraffic = !!analysisLaps?.length

  const index = Math.max(0, data.drivers.findIndex((d) => d.name === driver))
  const color = DRIVER_PALETTE[index % DRIVER_PALETTE.length]
  const shape = SHAPES[index % SHAPES.length]
  const stints = data.stints.filter((s) => s.driver === driver)

  const series = useMemo<Series[]>(() => {
    const laps = data.laps.filter((l) => l.driver === driver)
    const byLap = new Map((analysisLaps ?? []).map((a) => [a.lap, a]))
    // Tipos de cada vuelta. Una vuelta puede tener varios (FCY + entrada a boxes) y
    // solo se muestra si todos sus tipos están activados.
    const kinds = (l: (typeof laps)[number]): LapKind[] => {
      const a = byLap.get(l.lap)
      const out: LapKind[] = []
      if (a ? a.is_neutralized : l.flag !== "") out.push("neutralized")
      if (a?.is_in_lap || l.pit === "in") out.push("in")
      if (a?.is_out_lap || l.pit === "out") out.push("out")
      if (!out.length && !l.isPace) out.push("slow")
      return out
    }
    const toPoint = (l: (typeof laps)[number], extra = ""): Point[] =>
      l.seconds === null
        ? []
        : [
            {
              x: l.lap,
              y: l.seconds,
              who: driver,
              note: [
                `${overall ? `${where(l)} · ` : ""}Stint ${l.stint} · vuelta ${l.stintLap} del stint`,
                l.isPace ? "" : l.status,
                extra,
              ]
                .filter(Boolean)
                .join(" · "),
            },
          ]
    const visible = laps.filter((l) => kinds(l).every((k) => shown[k]))
    const pace = visible.filter((l) => kinds(l).length === 0)
    const out: Series[] = [
      {
        id: "pace",
        label: "Vueltas de ritmo",
        color,
        shape,
        line: true,
        points: markBest(pace.flatMap((l) => toPoint(l))),
      },
    ]
    // Vueltas no de ritmo visibles, agrupadas por su tipo principal.
    const groups = new Map<string, Series>()
    for (const l of visible) {
      const [kind] = kinds(l)
      if (!kind) continue
      const a = byLap.get(l.lap)
      let key: string = kind
      let style: { color: string; shape: Shape }
      let label = LAP_KIND_LABELS[kind]
      if (kind === "neutralized") {
        const code = l.flag || (a?.flag && a.flag !== "GF" ? a.flag : "FCY")
        const info = flagInfo(code)
        key = `flag-${code}`
        label = `${code} · ${info.name}`
        style = info
      } else if (kind === "in") style = IN_LAP_STYLE
      else if (kind === "out") style = OUT_LAP_STYLE
      else style = { color: EXCLUDED_COLOR, shape: "cross" }
      const pitNote = a?.pit_time != null ? `Pit lane ${formatSeconds(a.pit_time)} s` : ""
      const group = groups.get(key) ?? {
        id: `kind-${key}`,
        label,
        ...style,
        line: false,
        points: [],
      }
      group.points.push(...toPoint(l, pitNote))
      groups.set(key, group)
    }
    out.push(...groups.values())
    // Tráfico: anillo naranja alrededor de las vueltas visibles con pérdida estimada.
    if (highlightTraffic && hasTraffic) {
      const traffic = visible.flatMap((l) => {
        const loss = byLap.get(l.lap)?.traffic_loss ?? 0
        return loss > 0 ? toPoint(l, `Tráfico: ${formatSigned(loss)} s estimados`) : []
      })
      if (traffic.length)
        out.push({
          id: "traffic",
          label: "Vuelta con tráfico",
          color: TRAFFIC_COLOR,
          shape: "ring",
          line: false,
          scale: 1.9,
          points: traffic,
        })
    }
    if (showTrend) {
      for (const stint of stints) {
        if (!stint.trend) continue
        const inStint = laps.filter((l) => l.stint === stint.stint && l.isPace)
        if (inStint.length < 2) continue
        const first = inStint[0]
        const last = inStint[inStint.length - 1]
        const at = (stintLap: number) => stint.trend!.intercept + stint.trend!.slope * stintLap
        out.push({
          id: `trend-${stint.stint}`,
          label: "Tendencia por stint",
          color: "#E6EDF5",
          shape: "circle",
          line: true,
          dashed: true,
          markers: false,
          points: [
            { x: first.lap, y: at(first.stintLap), who: driver },
            { x: last.lap, y: at(last.stintLap), who: driver },
          ],
        })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, driver, showTrend, shown, highlightTraffic, analysisLaps])

  const bands: Band[] = stints.map((s) => ({
    from: s.startLap,
    to: s.endLap,
    label: `Stint ${s.stint}`,
    short: `S${s.stint}`,
  }))
  const legend = series.filter((s, i, all) => all.findIndex((t) => t.label === s.label) === i)

  return (
    <section className="stint-section" id="stint">
      <div className="section-title">
        <div>
          <div className="eyebrow">
            <span /> EVOLUCIÓN EN EL STINT
          </div>
          <h2>Gráfico ritmo por vuelta</h2>
          <p>Elige un piloto del coche para ver cómo evoluciona su ritmo durante cada stint.</p>
        </div>
        <label className="car-select">
          <span>PILOTO</span>
          <select value={driver} onChange={(event) => setDriver(event.target.value)}>
            {data.drivers.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <article className="panel stint-panel">
        <div className="stint-controls">
          <label className="check">
            <input
              type="checkbox"
              checked={showTrend}
              onChange={(event) => setShowTrend(event.target.checked)}
            />
            Tendencia por stint
          </label>
          <span className="stint-controls-sep" aria-hidden="true" />
          <span className="stint-controls-label">Mostrar:</span>
          {(["in", "out", "neutralized", "slow"] as LapKind[]).map((kind) => (
            <label className="check" key={kind}>
              <input
                type="checkbox"
                checked={shown[kind]}
                onChange={(event) => setShown({ ...shown, [kind]: event.target.checked })}
              />
              {LAP_KIND_LABELS[kind]}
            </label>
          ))}
          <span className="stint-controls-sep" aria-hidden="true" />
          <label
            className="check"
            title={hasTraffic ? undefined : "Necesita el backend de análisis de carrera conectado"}
          >
            <input
              type="checkbox"
              checked={highlightTraffic && hasTraffic}
              disabled={!hasTraffic}
              onChange={(event) => setHighlightTraffic(event.target.checked)}
            />
            Resaltar tráfico
          </label>
        </div>
        <div className="stint-body">
          <div className="chart-head">
            <h3>
              {driver} · coche #{data.car.number}
            </h3>
            <span>{timeFormatLabel()} ↓</span>
          </div>
          <Legend series={legend} />
          <LineChart
            series={series}
            bands={bands}
            xLabel={overall ? "Vuelta acumulada" : "Vuelta"}
            label={`Ritmo por vuelta de ${driver} en el coche ${data.car.number}, por stint`}
          />
          <p className="chart-note">
            Las franjas marcan cada stint: desde la vuelta de salida de boxes hasta la de
            entrada. El círculo blanco señala la mejor vuelta.{" "}
            {hasTraffic
              ? "El anillo naranja marca las vueltas con tráfico: algún sector más de 0,4 s por encima de la mediana de 5 vueltas del piloto."
              : "El tráfico se resalta cuando el análisis de carrera del backend está disponible (no en «Todas las sesiones»)."}{" "}
            FCY / Safety Car = cualquier FLAG_AT_FL distinto de GF.
          </p>

          <div className="table-scroll stint-table">
            <table>
              <caption className="sr-only">Stints de {driver}</caption>
              <thead>
                <tr>
                  <th scope="col">Stint</th>
                  <th scope="col">Vueltas</th>
                  <th scope="col">De ritmo</th>
                  <th scope="col">Mejor vuelta</th>
                  <th scope="col">Ritmo medio</th>
                  <th scope="col">Tendencia</th>
                </tr>
              </thead>
              <tbody>
                {stints.map((s) => (
                  <tr key={s.stint}>
                    <td>{s.stint}</td>
                    <td>
                      {s.startLap}–{s.endLap} ({s.laps})
                    </td>
                    <td>{s.paceLaps}</td>
                    <td>{s.best.text}</td>
                    <td>{s.median.text}</td>
                    <td>{s.trend ? `${formatSigned(s.trend.slope)} s/vuelta` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="chart-note">
            Ritmo medio = mediana de las vueltas de ritmo. La tendencia es la pendiente del
            tiempo de vuelta dentro del stint (positiva = el ritmo cae) y se calcula con al
            menos 3 vueltas de ritmo. Mezcla neumáticos, combustible y tráfico: úsala como
            orientación, sobre todo en sesiones de libres.
          </p>
        </div>
      </article>
    </section>
  )
}

// Análisis de las paradas en boxes de un coche: tiempo medio con y sin cambio de piloto.
function PitPanel({ data }: { data: CarData }) {
  const { pitSummary: summary, pitStops: stops } = data

  const card = (label: string, group: PitGroup, accent?: boolean) => (
    <MetricCard
      label={label}
      value={group.count ? group.mean.text : "–"}
      note={
        group.count === 0
          ? "Sin paradas de este tipo"
          : `${group.count} ${group.count === 1 ? "parada" : "paradas"} · tiempo medio`
      }
      detail={group.count ? `Mejor ${group.best.text} · Peor ${group.worst.text}` : "—"}
      accent={accent}
    />
  )

  return (
    <section className="pit-section" id="pit">
      <div className="section-title">
        <div>
          <div className="eyebrow">
            <span /> ESTRATEGIA
          </div>
          <h2>Análisis de pit stop</h2>
          <p>Tiempo en boxes de las paradas del coche #{data.car.number}, según haya o no relevo.</p>
        </div>
      </div>

      <div className="metrics-grid pit-metrics">
        {card("Parada con cambio de piloto", summary.withChange, true)}
        {card("Parada sin cambio de piloto", summary.withoutChange)}
      </div>

      <article className="panel">
        <div className="stint-body">
          {stops.length === 0 ? (
            <p className="chart-empty">Este coche no ha hecho paradas en los datos cargados.</p>
          ) : (
            <div className="table-scroll stint-table">
              <table>
                <caption className="sr-only">Paradas en boxes del coche {data.car.number}</caption>
                <thead>
                  <tr>
                    <th scope="col">Parada</th>
                    <th scope="col">Vueltas</th>
                    <th scope="col">Tipo</th>
                    <th scope="col">Sale</th>
                    <th scope="col">Entra</th>
                    <th scope="col">Tiempo en boxes</th>
                  </tr>
                </thead>
                <tbody>
                  {stops.map((s, i) => (
                    <tr key={`${s.fromLap}-${s.toLap}`}>
                      <td>P{i + 1}</td>
                      <td>
                        {s.fromLap}→{s.toLap}
                      </td>
                      <td>{s.driverChange ? "Cambio de piloto" : "Sin cambio"}</td>
                      <td>{s.driverOut}</td>
                      <td>{s.driverChange ? s.driverIn : "—"}</td>
                      <td>{s.pit.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="chart-note">
            El tiempo es el que registra el cronometraje en boxes en la vuelta de salida. No incluye
            la espera inicial antes del primer stint ni el paso de una sesión a otra en «Todas las
            sesiones». Las paradas sin tiempo registrado no entran en la media.
          </p>
        </div>
      </article>
    </section>
  )
}

function Dashboard({
  sessionId,
  sessionName,
  eventName,
  sessions,
  onSession,
  slow,
  onSlow,
  category,
  categories,
  overall,
  onCategory,
  onHome,
  onPickFiles,
}: {
  onPickFiles: () => void
  sessionId: string
  sessionName: string
  eventName: string
  sessions: SessionInfo[]
  onSession: (id: string) => void
  slow: number
  onSlow: (pct: number) => void
  category: string
  categories: { id: string; label: string }[]
  overall: boolean // datos de todas las sesiones juntas
  onCategory: (category: string) => void
  onHome: () => void
}) {
  const [metric, setMetric] = useState<Metric>("lap")
  const [mode, setMode] = useState<Mode>("ritmo")
  const [overlay, setOverlay] = useState(false)
  const [selectedCar, setSelectedCar] = useState<string | null>(null)
  const [compare, setCompare] = useState<Selection[]>([])

  const cat = useApi(() => api.category(sessionId, category, slow), [sessionId, category, slow])
  const car = useApi(
    selectedCar ? () => api.car(sessionId, selectedCar, slow) : null,
    [sessionId, selectedCar, slow],
  )
  // Análisis de carrera (tráfico, gaps, degradación en aire limpio): solo sesiones concretas.
  const race = useApi(
    overall ? null : () => loadRaceAnalysis(sessionId, category),
    [sessionId, category, overall],
  )
  const carAnalysisLaps = useMemo(
    () =>
      race.data?.source === "api" && selectedCar
        ? race.data.laps.filter((l) => l.car === selectedCar)
        : undefined,
    [race.data, selectedCar],
  )

  // Coche por defecto: el más rápido de la categoría.
  useEffect(() => {
    const data = cat.data
    if (!data) return
    setSelectedCar((current) =>
      current && data.cars.some((c) => c.number === current)
        ? current
        : (data.rankings.lap[0]?.car ?? data.cars[0]?.number ?? null),
    )
  }, [cat.data])

  // Por defecto se comparan los más rápidos; si cambian de categoría, se vuelve a ese valor.
  const activeCompare = useMemo<Selection[]>(() => {
    const data = cat.data
    if (!data) return []
    const valid = compare.filter((c) => data.cars.some((x) => x.number === c.car))
    return valid.length
      ? valid
      : data.rankings.lap.slice(0, MAX_COMPARE).map((r, slot) => ({ car: r.car, slot }))
  }, [cat.data, compare])
  const paceChartSeries = useMemo<Series[]>(
    () => (cat.data ? paceSeries(cat.data, activeCompare, overall) : []),
    [cat.data, activeCompare, overall],
  )
  const compareSeries = useMemo(
    () =>
      car.data
        ? overlay
          ? overlaySeries(car.data, mode, overall)
          : driverSeries(car.data, mode, overall)
        : [],
    [car.data, mode, overlay, overall],
  )

  if (cat.error) return <Status title="No se pudieron cargar los datos" detail={cat.error} />
  if (!cat.data) return <Status busy title="Cargando datos…" />

  const data = cat.data
  const ranking = data.rankings[metric]
  const metricTitle = METRIC_TABS.find((t) => t.key === metric)?.title ?? ""
  const carOption = data.cars.find((c) => c.number === selectedCar)

  function exportCsv(rows: RankingRow[]) {
    const lines = [
      ["Posición", "Coche", "Equipo", "Piloto", metricTitle, "Diferencia", "Vuelta", "Hora"],
      ...rows.map((r) => [r.position, r.car, r.team, r.driver, r.text, r.gapText, r.lap, r.clock]),
    ].map((line) => line.map(csvCell).join(";"))
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `race-strategy-${category.toLowerCase()}-${metric}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  function changeCategory(next: string) {
    setSelectedCar(null)
    setCompare([])
    onCategory(next)
  }

  function toggleCar(car: string) {
    const existing = activeCompare.find((c) => c.car === car)
    if (existing) {
      if (activeCompare.length > 1) setCompare(activeCompare.filter((c) => c.car !== car))
      return
    }
    if (activeCompare.length >= MAX_COMPARE) return
    const used = new Set(activeCompare.map((c) => c.slot))
    const slot = Array.from({ length: MAX_COMPARE }, (_, i) => i).find((i) => !used.has(i)) ?? 0
    setCompare([...activeCompare, { car, slot }])
  }

  const drivers = car.data?.drivers ?? []
  // Barras de diferencia de ritmo medio: escala común a todos los pilotos, mínimo 0,6 s.
  const maxGap = drivers.reduce((max, d) => Math.max(max, d.meanGap.seconds ?? 0), 0)
  const scaleMax = Math.max(0.6, Math.ceil(maxGap * 10) / 10)
  // Con "Superponer pilotos" el eje es la vuelta del stint y las paradas no tienen posición.
  const pitStops = overlay ? [] : (car.data?.pitStops ?? [])

  return (
    <div className="app-shell dashboard-shell">
      <Header categoryLabel={data.category.label} onHome={onHome} />
      <aside className="sidebar" aria-label="Navegación de análisis">
        <button className="active" aria-label="Resumen">
          <Icon name="chart" />
        </button>
        <a href="#ranking" aria-label="Clasificación">
          <Icon name="grid" />
        </a>
        <a href="#drivers" aria-label="Pilotos">
          <Icon name="clock" />
        </a>
      </aside>
      <main className="dashboard">
        <section className="dashboard-heading">
          <div>
            <div className="eyebrow">
              <span /> ANÁLISIS DE RENDIMIENTO
            </div>
            <div className="title-row">
              <h1>Análisis {data.category.label}</h1>
              <span className="sample-badge">{sessionName}</span>
            </div>
          </div>
          <div className="heading-actions">
            <label>
              <span className="sr-only">Cambiar categoría</span>
              <select
                value={category}
                onChange={(event) => changeCategory(event.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => exportCsv(ranking)}>
              Exportar informe <Icon name="download" size={15} />
            </button>
          </div>
        </section>

        <section className="filter-row" aria-label="Filtros del análisis">
          <SessionSelect
            className="filter-select"
            sessions={sessions}
            value={sessionId}
            onChange={onSession}
            category={category}
            categoryLabel={data.category.label}
          />
          <button type="button" className="pick-files" onClick={onPickFiles}>
            Archivos…
          </button>
          <label className="filter-select">
            <span className="select-label">Vuelta lenta</span>
            <select value={slow} onChange={(event) => onSlow(Number(event.target.value))}>
              {SLOW_OPTIONS.map((pct) => (
                <option key={pct} value={pct}>
                  más del {pct} % de la mejor
                </option>
              ))}
            </select>
          </label>
          <span className="data-count">
            {data.counts.laps.toLocaleString("es-ES")} vueltas / {data.counts.drivers} pilotos /{" "}
            {data.counts.cars} coches
          </span>
        </section>

        <div className="tabs" role="tablist" aria-label="Métrica de la clasificación">
          {METRIC_TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={metric === tab.key}
              className={metric === tab.key ? "active" : ""}
              onClick={() => setMetric(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <section className="metrics-grid" aria-label="Mejores tiempos de la categoría">
          {data.bests.map((best) => (
            <MetricCard
              key={best.key}
              label={`${best.label} ${overall ? "overall" : "de la categoría"}`}
              value={best.text}
              note={`#${best.car} · ${best.driver}`}
              detail={`${best.team} · ${overall ? `${best.session} · ` : ""}vuelta ${best.lap} · ${best.clock} (sesión ${best.elapsed})`}
              accent={best.key === "lap"}
            />
          ))}
        </section>

        <section className="analysis-grid">
          <article className="panel pace-panel">
            <div className="panel-heading">
              <div>
                <h2>Evolución del ritmo</h2>
                <p aria-live="polite">
                  {activeCompare.length} de {MAX_COMPARE} coches · vueltas de ritmo · elige los
                  coches en la clasificación
                </p>
              </div>
              <span className="panel-unit">TIEMPO / VUELTA</span>
            </div>
            <Legend series={paceChartSeries} />
            <LineChart
              series={paceChartSeries}
              interactiveY
              xLabel={overall ? "Vuelta acumulada" : "Vuelta"}
              resetKey={`${category}|${activeCompare.map((c) => c.car).join(",")}`}
              label="Tiempo por vuelta de los coches seleccionados de la categoría"
            />
          </article>

          <article className="panel ranking-panel" id="ranking">
            <div className="panel-heading">
              <div>
                <h2>Clasificación por {metric === "lap" ? "ritmo" : "sector"}</h2>
                <p>{metricTitle} · marca hasta {MAX_COMPARE} coches para comparar</p>
              </div>
              <span className="panel-unit">{ranking.length} COCHES</span>
            </div>
            <ol className="ranking-list" tabIndex={0} aria-label={`Clasificación: ${metricTitle}`}>
              {ranking.map((row, index) => {
                const pick = activeCompare.find((c) => c.car === row.car)
                const atMax = !pick && activeCompare.length >= MAX_COMPARE
                const onlyOne = !!pick && activeCompare.length === 1
                return (
                  <li
                    key={row.car}
                    className={`${index === 0 ? "leader" : ""} ${pick ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      className="compare-check"
                      checked={!!pick}
                      disabled={atMax || onlyOne}
                      title={
                        atMax
                          ? `Máximo ${MAX_COMPARE} coches`
                          : onlyOne
                            ? "Debe quedar al menos un coche"
                            : undefined
                      }
                      onChange={() => toggleCar(row.car)}
                      aria-label={`Comparar el ritmo del coche #${row.car} ${row.team}`}
                    />
                    <span className="rank">{String(row.position).padStart(2, "0")}</span>
                    <span className="team">
                      {pick && (
                        <svg
                          className="team-swatch"
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          aria-hidden="true"
                        >
                          <Marker
                            shape={SHAPES[pick.slot % SHAPES.length]}
                            x={6}
                            y={6}
                            r={3.4}
                            color={PALETTE[pick.slot % PALETTE.length]}
                          />
                        </svg>
                      )}
                      #{row.car} {row.team}
                      <small>
                        {row.driver} · {overall ? `${row.session} · ` : ""}vuelta {row.lap}
                      </small>
                    </span>
                    <strong>{row.text}</strong>
                    <small className="delta">{row.gapText}</small>
                  </li>
                )
              })}
            </ol>
          </article>
        </section>

        <div className="insight-bar">
          <span>i</span>
          <p>
            <strong>Lectura rápida:</strong> {data.counts.paceLaps} de{" "}
            {data.counts.laps} vueltas de la categoría cuentan como ritmo. Se
            excluyen las de entrada y salida de boxes, las de bandera FCY y las
            que superan el {slow} % de la mejor vuelta de su coche.
          </p>
        </div>

        <section className="drivers-section" id="drivers">
          <div className="section-title">
            <div>
              <div className="eyebrow">
                <span /> COMPARATIVA INTERNA
              </div>
              <h2>Dentro del mismo coche</h2>
              <p>Selecciona un coche y compara el ritmo de sus pilotos.</p>
            </div>
            <label className="car-select">
              <span>COCHE</span>
              <select
                value={selectedCar ?? ""}
                onChange={(event) => setSelectedCar(event.target.value)}
              >
                {data.cars.map((c) => (
                  <option value={c.number} key={c.number}>
                    #{c.number} · {c.team}
                    {c.manufacturer ? ` · ${c.manufacturer}` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <article className="panel driver-panel">
            {car.error && <p className="chart-empty">{car.error}</p>}
            {!car.data && !car.error && <p className="chart-empty">Cargando coche…</p>}
            {car.data && (
              <>
                <div className="car-header">
                  <span className="car-number">{car.data.car.number}</span>
                  <div>
                    <strong>{car.data.car.team}</strong>
                    <small>{car.data.car.manufacturer || carOption?.team}</small>
                  </div>
                  <span className="driver-count">
                    {car.data.drivers.length} PILOTOS · {car.data.counts.laps} VUELTAS
                  </span>
                  <div className="mode-switch" role="group" aria-label="Vueltas a mostrar">
                    <button
                      className={mode === "ritmo" ? "active" : ""}
                      aria-pressed={mode === "ritmo"}
                      onClick={() => setMode("ritmo")}
                    >
                      Ritmo
                    </button>
                    <button
                      className={mode === "todas" ? "active" : ""}
                      aria-pressed={mode === "todas"}
                      onClick={() => setMode("todas")}
                    >
                      Todas las vueltas
                    </button>
                  </div>
                </div>

                <div className="driver-content">
                  <div className="driver-chart">
                    <div className="chart-block">
                      <div className="chart-head">
                        <h3>Ritmo por vuelta</h3>
                        <span>{timeFormatLabel()} ↓</span>
                      </div>
                      <label className="check overlay-toggle">
                        <input
                          type="checkbox"
                          checked={overlay}
                          onChange={(event) => setOverlay(event.target.checked)}
                        />
                        Superponer pilotos
                      </label>
                      <Legend series={compareSeries} pit={pitStops.length > 0} />
                      <LineChart
                        wide
                        series={compareSeries}
                        pitStops={pitStops}
                        xLabel={overlay ? "Vuelta del stint" : overall ? "Vuelta acumulada" : "Vuelta"}
                        label={`Tiempo por vuelta de los pilotos del coche ${car.data.car.number}${overlay ? ", superpuestos por vuelta del stint" : ""}`}
                      />
                    </div>
                    {mode === "todas" && (
                      <p className="chart-note">
                        Las vueltas bajo bandera llevan el color y la forma de su bandera (la
                        bandera es la que había al cruzar la meta). El anillo gris azulado marca
                        las de boxes y las cruces grises, las lentas sin bandera.
                      </p>
                    )}
                    {overlay && (
                      <p className="chart-note">
                        Cada stint empieza en la vuelta 1 (salida de boxes) para ver los ritmos de
                        los pilotos unos encima de otros. Si un piloto tiene varios stints, se
                        distinguen por el trazo.
                      </p>
                    )}
                  </div>

                  <div className="driver-summary">
                    <div className="summary-head">
                      <h3>Ritmo medio por piloto</h3>
                      <span>Δ al más rápido</span>
                    </div>
                    <div className="pace-grid">
                    {drivers.map((driver, index) => {
                      const color = DRIVER_PALETTE[index % DRIVER_PALETTE.length]
                      const gap = driver.meanGap.seconds
                      return (
                        <div className="pace-row" key={driver.name}>
                          <span className="pace-swatch" style={{ background: color }} />
                          <div className="pace-name">
                            <strong>{driver.name}</strong>
                            <small>
                              {driver.paceLaps} vueltas de ritmo · Mediana {driver.median.text}
                            </small>
                            <small>
                              S1 {driver.s1.text} · S2 {driver.s2.text} · S3 {driver.s3.text}
                            </small>
                          </div>
                          <div className="pace-stats">
                            <div className="pace-stat" style={{ borderLeftColor: color }}>
                              <small className="pace-stat-label">RITMO MEDIO</small>
                              <span style={{ color }}>{driver.mean.text}</span>
                              <small>{driver.meanGap.text}</small>
                            </div>
                            <div className="pace-stat">
                              <small className="pace-stat-label">VUELTA RÁPIDA</small>
                              <span>{driver.best.text}</span>
                              <small>{driver.deltaText}</small>
                            </div>
                          </div>
                          <div className="pace-track" aria-hidden="true">
                            <i
                              style={{
                                width: `${gap === null ? 0 : Math.max(2, (gap / scaleMax) * 100)}%`,
                                background: color,
                              }}
                            />
                          </div>
                        </div>
                      )
                    })}
                    </div>
                  </div>
                </div>

                <details className="lap-table">
                  <summary>Ver todas las vueltas del coche como tabla</summary>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {overall && <th scope="col">Sesión</th>}
                          <th scope="col">Vuelta</th>
                          <th scope="col">Piloto</th>
                          <th scope="col">Tiempo</th>
                          <th scope="col">S1</th>
                          <th scope="col">S2</th>
                          <th scope="col">S3</th>
                          <th scope="col">Hora</th>
                          <th scope="col">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {car.data.laps.map((lap) => (
                          <tr key={lap.lap}>
                            {overall && <td>{lap.session}</td>}
                            <td>{overall ? lap.sessionLap : lap.lap}</td>
                            <td>{lap.driver}</td>
                            <td>{lap.text}</td>
                            <td>{lap.s1}</td>
                            <td>{lap.s2}</td>
                            <td>{lap.s3}</td>
                            <td>{lap.clock}</td>
                            <td>{lap.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </article>
        </section>

        {car.data && <PitPanel key={`pit-${car.data.car.number}`} data={car.data} />}
        {car.data && (
          <StintPanel
            key={car.data.car.number}
            data={car.data}
            overall={overall}
            analysisLaps={carAnalysisLaps}
          />
        )}
        <RaceAnalysisSection
          state={race}
          overall={overall}
          focusCar={selectedCar}
          categoryLabel={data.category.label}
          sessionName={sessionName}
          sessionId={sessionId}
        />
      </main>
      <Footer sessionName={sessionName} eventName={eventName} />
    </div>
  )
}

// Si algo falla al dibujar el análisis, se muestra el error en vez de una pantalla en negro.
class ErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="app-shell">
        <Header />
        <main className="status" role="alert">
          <h1>Algo ha fallado al mostrar el análisis</h1>
          <p>{error.message}</p>
          <button
            className="primary-button"
            style={{ maxWidth: 220 }}
            onClick={() => {
              this.setState({ error: null })
              this.props.onReset()
            }}
          >
            Volver al inicio
          </button>
        </main>
        <Footer />
      </div>
    )
  }
}

// ---------------------------------------------------------------------------
// App: arranque, sesión activa y navegación inicio <-> análisis
// ---------------------------------------------------------------------------
export default function App() {
  const boot = useApi(api.sessions, [])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [slow, setSlow] = useState(107)
  const [category, setCategory] = useState<string | null>(null)

  useEffect(() => {
    if (!boot.data) return
    setMsSeparator(boot.data.settings.msSeparator)
    setSlow(boot.data.settings.slowThresholdPct)
    // por defecto, una sesión real (la de "todas las sesiones" se elige a propósito)
    setSessionId(
      (current) =>
        current ??
        boot.data?.sessions.find((s) => !s.overall)?.id ??
        boot.data?.sessions[0]?.id ??
        null,
    )
  }, [boot.data])

  const overview = useApi(sessionId ? () => api.overview(sessionId) : null, [sessionId])
  const [picking, setPicking] = useState(false)
  const [hourlyEvent, setHourlyEvent] = useState<string | null>(null)

  // Una selección de varios archivos no está en la lista del backend: se añade para que
  // el desplegable de sesión la muestre.
  const sessions = useMemo<SessionInfo[]>(() => {
    const list = boot.data?.sessions ?? []
    const ov = overview.data
    if (!sessionId || !selectionIds(sessionId) || !ov || list.some((s) => s.id === sessionId)) return list
    return [
      ...list,
      {
        id: sessionId,
        name: ov.session.name,
        overall: true,
        event: ov.session.event,
        eventName: ov.session.eventName,
        categories: ov.categories.map((c) => c.id),
      },
    ]
  }, [boot.data, overview.data, sessionId])

  const firstSession = boot.data?.sessions.find((s) => !s.overall)?.id ?? boot.data?.sessions[0]?.id ?? null
  const classifications = boot.data?.classifications ?? []
  const openHourly = (event: string) => {
    setPicking(false)
    setHourlyEvent(event)
  }
  const picker =
    picking && boot.data ? (
      <FilePicker
        files={boot.data.files ?? []}
        classifications={classifications}
        current={sessionId}
        dataDir={boot.data.dataDir}
        onAnalyze={(ids) => {
          setPicking(false)
          setHourlyEvent(null)
          setCategory(null)
          setSessionId(selectionId(ids))
        }}
        onClassification={openHourly}
        onClose={() => setPicking(false)}
      />
    ) : null
  const hourlyButtons = classifications.map((c) => (
    <button key={c.event} type="button" className="primary-button" onClick={() => openHourly(c.event)}>
      Clasificación por horas · {c.eventName}
    </button>
  ))

  if (boot.error) return <Status title="No se pudo conectar con el backend" detail={boot.error} />
  if (!boot.data) return <Status busy title="Conectando con el backend…" />

  if (hourlyEvent) {
    return (
      <div className="app-shell dashboard-shell">
        <Header onHome={() => setHourlyEvent(null)} />
        <main className="dashboard">
          <ClassificationView event={hourlyEvent} onBack={() => setHourlyEvent(null)} />
        </main>
        <Footer />
        {picker}
      </div>
    )
  }

  if (boot.data.sessions.length === 0) {
    return (
      <>
        <Status
          title="No hay sesiones de vueltas para analizar"
          detail={`No hay archivos de vueltas (…_Analysis_….CSV) en ${boot.data.dataDir}.`}
        >
          {hourlyButtons}
        </Status>
        {picker}
      </>
    )
  }
  if (overview.error)
    return (
      <>
        <Status title="No se pudo cargar la sesión" detail={overview.error}>
          <button type="button" className="primary-button" onClick={() => setPicking(true)}>
            Elegir otros archivos
          </button>
          {firstSession && firstSession !== sessionId && (
            <button type="button" className="primary-button secondary" onClick={() => setSessionId(firstSession)}>
              Volver a la primera sesión
            </button>
          )}
        </Status>
        {picker}
      </>
    )
  if (!sessionId || !overview.data) return <Status busy title="Importando la sesión…" />

  if (!category) {
    return (
      <>
        <Landing
          overview={overview.data}
          sessions={sessions}
          sessionId={sessionId}
          onSession={setSessionId}
          onSelect={setCategory}
          onPickFiles={() => setPicking(true)}
          classifications={classifications}
          onClassification={openHourly}
        />
        {picker}
      </>
    )
  }

  return (
    <ErrorBoundary key={`${sessionId}|${category}`} onReset={() => setCategory(null)}>
      <Dashboard
        sessionId={sessionId}
        sessionName={overview.data.session.name}
        eventName={overview.data.session.eventName}
        sessions={sessions}
        onSession={setSessionId}
        slow={slow}
        onSlow={setSlow}
        category={category}
        categories={overview.data.categories}
        overall={overview.data.overall}
        onCategory={setCategory}
        onHome={() => setCategory(null)}
        onPickFiles={() => setPicking(true)}
      />
      {picker}
    </ErrorBoundary>
  )
}