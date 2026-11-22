// Chips para elegir qué coches se dibujan en una gráfica (por defecto los primeros N
// más los que siempre deben verse, p. ej. la referencia o el coche seleccionado).

import { useState } from "react"
import { carColor } from "./chartUtils"

export const DEFAULT_VISIBLE = 8

export function useCarPicker(order: string[], always: string[], count = DEFAULT_VISIBLE) {
  const [picked, setPicked] = useState<string[] | null>(null)
  const defaults = [...new Set([...order.slice(0, count), ...always.filter(Boolean)])]
  const visible = (picked ?? defaults).filter((c) => order.includes(c))
  return {
    visible,
    count,
    toggle: (car: string) =>
      setPicked(visible.includes(car) ? visible.filter((c) => c !== car) : [...visible, car]),
    all: () => setPicked(order),
    top: () => setPicked(null),
  }
}

export function CarChips({
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
        Top {picker.count}
      </button>
    </div>
  )
}
