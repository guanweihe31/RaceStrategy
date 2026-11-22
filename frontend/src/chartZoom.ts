// Zoom de caja al estilo MoTeC i2 para las gráficas SVG:
//   - arrastrar con el botón DERECHO dibuja una caja y amplía a ella
//     (si la caja es muy baja, solo se amplía el eje X),
//   - clic derecho sin arrastrar: vuelve al zoom anterior,
//   - doble clic (o reset()): vuelve a ver todo.
// Cada zoom se apila, así que se puede deshacer paso a paso.

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react"

export type ZoomBox = { x0: number; x1: number; y0: number | null; y1: number | null }

export type PlotFrame = {
  width: number // ancho del viewBox
  height: number // alto del viewBox
  left: number
  top: number
  plotW: number
  plotH: number
  // de unidades del viewBox a unidades de los datos
  toX: (px: number) => number
  toY: (py: number) => number
}

type Drag = { x0: number; y0: number; x1: number; y1: number }

const MIN_DRAG = 6 // unidades del viewBox: menos que esto es un clic

export function useBoxZoom(resetKey = "") {
  const [stack, setStack] = useState<ZoomBox[]>([])
  const [drag, setDragState] = useState<Drag | null>(null)
  // la caja en curso también en una ref: los eventos seguidos no esperan a que React pinte
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }

  useEffect(() => {
    setStack([])
    setDrag(null)
  }, [resetKey])

  const view = stack.length ? stack[stack.length - 1] : null

  function local(event: PointerEvent<SVGSVGElement>, frame: PlotFrame) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / (rect.width || 1)) * frame.width
    const y = ((event.clientY - rect.top) / (rect.height || 1)) * frame.height
    return {
      x: Math.min(frame.left + frame.plotW, Math.max(frame.left, x)),
      y: Math.min(frame.top + frame.plotH, Math.max(frame.top, y)),
    }
  }

  /** Devuelve true si el evento era del zoom (para que la gráfica no lo procese). */
  function onPointerDown(event: PointerEvent<SVGSVGElement>, frame: PlotFrame): boolean {
    if (event.button !== 2) return false
    const p = local(event, frame)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    return true
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>, frame: PlotFrame): boolean {
    const current = dragRef.current
    if (!current) return false
    const p = local(event, frame)
    setDrag({ ...current, x1: p.x, y1: p.y })
    return true
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>, frame: PlotFrame): boolean {
    const current = dragRef.current
    if (!current) return false
    const p = local(event, frame)
    const drag = { ...current, x1: p.x, y1: p.y }
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    setDrag(null)
    if (w < MIN_DRAG && h < MIN_DRAG) {
      setStack((s) => s.slice(0, -1)) // clic derecho: zoom anterior
      return true
    }
    if (w < MIN_DRAG) return true
    const xs = [frame.toX(drag.x0), frame.toX(drag.x1)].sort((a, b) => a - b)
    const ys = [frame.toY(drag.y0), frame.toY(drag.y1)].sort((a, b) => a - b)
    setStack((s) => [
      ...s,
      { x0: xs[0], x1: xs[1], y0: h < MIN_DRAG ? null : ys[0], y1: h < MIN_DRAG ? null : ys[1] },
    ])
    return true
  }

  return {
    view,
    depth: stack.length,
    selection: drag
      ? {
          x: Math.min(drag.x0, drag.x1),
          y: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
        }
      : null,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    back: () => setStack((s) => s.slice(0, -1)),
    reset: () => {
      setStack([])
      setDrag(null)
    },
    // el menú contextual del navegador taparía la caja
    onContextMenu: (event: MouseEvent) => event.preventDefault(),
  }
}

export const ZOOM_HINT = "Botón derecho: arrastra una caja para ampliar · clic derecho = zoom anterior · doble clic = ver todo"
