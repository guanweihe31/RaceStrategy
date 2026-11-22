"""CSV en formato Al Kamel que se va ampliando vuelta a vuelta, a prueba de cortes.

Cada vuelta se escribe y se fuerza a disco al momento. Si el colector se reinicia con
el mismo archivo, lee qué vueltas ya están y no las repite.
"""

from __future__ import annotations

import csv
import os
from pathlib import Path

from lap_builder import COLUMNS


class AlKamelWriter:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.known_laps: dict[str, int] = {}
        if path.exists() and path.stat().st_size > 0:
            with open(path, encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle, delimiter=";"):
                    number, lap = row.get("NUMBER", ""), row.get("LAP_NUMBER", "")
                    if number and lap.isdigit():
                        self.known_laps[number] = max(self.known_laps.get(number, 0), int(lap))
        new_file = not path.exists() or path.stat().st_size == 0
        self.handle = open(path, "a", encoding="utf-8", newline="")
        self.csv = csv.DictWriter(self.handle, fieldnames=COLUMNS, delimiter=";", extrasaction="ignore")
        if new_file:
            self.csv.writeheader()
            self._flush()
        self.rows = sum(self.known_laps.values())

    def write(self, rows: list[dict[str, str]]) -> None:
        if not rows:
            return
        self.csv.writerows(rows)
        self._flush()
        for row in rows:
            self.known_laps[row["NUMBER"]] = max(self.known_laps.get(row["NUMBER"], 0), int(row["LAP_NUMBER"]))
        self.rows += len(rows)

    def _flush(self) -> None:
        self.handle.flush()
        os.fsync(self.handle.fileno())

    def close(self) -> None:
        self.handle.close()
