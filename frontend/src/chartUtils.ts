// Utilidades compartidas por las gráficas de análisis de carrera.

import { formatSeconds } from "./api"

export const CAR_PALETTE = [
  "#42D6FF", "#D4F25C", "#B79CFF", "#FFB454", "#5BD19F", "#FF8FA3",
  "#2F80FF", "#E6EDF5", "#FF6B35", "#9FB0C2", "#C084FC", "#7BE0C3",
]

export function carColor(order: string[], car: string): string {
  const i = order.indexOf(car)
  return CAR_PALETTE[(i < 0 ? order.length : i) % CAR_PALETTE.length]
}

/** Número con `digits` decimales (0-3) y el separador de milésimas del backend. */
export function secs(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–"
  const text = formatSeconds(Number(value.toFixed(digits)))
  if (digits >= 3) return text
  return text.slice(0, digits === 0 ? -4 : digits - 3)
}

/** Marca de un eje de diferencias: "+20 s", "−10 s". */
export function gapTick(t: number): string {
  if (t === 0) return "0"
  const sign = t > 0 ? "+" : "−"
  return `${sign}${String(Number(Math.abs(t).toFixed(3))).replace(".", formatSeconds(0)[1])} s`
}

export function ticks(min: number, max: number, target: number): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / target
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Number(t.toFixed(6)))
  return out
}
