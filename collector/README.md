# LMU live collector

Records **Le Mans Ultimate** timing live and writes it as an Al Kamel-style lap file
(`…_Analysis_….CSV`), so RaceStrategy reads it like any official WEC file.

```
backend/data/raw/LMU/<date> <track>/<HHMM>_Analysis_<Session>.CSV
```

## Use

| Double-click | What it does |
|---|---|
| `Start LMU Collector.bat` (project root) | Waits for LMU, then saves every lap as it is completed. Leave the window open for the whole session. Also keeps a raw recording in `logs/lmu-raw-*.jsonl.gz`. |
| `collector/Probe LMU.bat` | With LMU open **inside a session**: saves one raw answer from LMU to `logs/lmu-probe-*.json` and prints what it understood. |
| `collector/Test with simulated race.bat` | Fake 8-car multi-class race at 30× speed (pit stops, driver changes, FCY, traffic). No game needed. |

In RaceStrategy, refresh the page and pick the LMU session (or *Elegir archivos…*).
New laps appear on each refresh.

Safe for long races: every lap is written and flushed to disk immediately. If the
collector is closed or crashes, start it again: it continues the same file and never
duplicates a lap. Laps completed while it was closed cannot be recovered; the console
reports how many were missed.

Run it on a PC that is **not** driving if possible (a spectator client): a crash or CPU
spike then can't affect the car on track. `--url http://<pc-ip>:6397` reads LMU on
another PC of the network, if LMU accepts connections from other PCs.

## ⚠ Not yet verified with the real game (to review together)

The data comes from the game's local web API, the one its own interface uses. rFactor 2
(LMU's engine) serves it on port 5397, and LMU on **6397**, at `/rest/watch/sessionInfo` and
`/rest/watch/standings`. Field names are taken from rFactor 2 and **have not been checked
with LMU**. `sources.py → map_rest` accepts several variants. First session with the game:

1. Open LMU and enter a session (practice is enough), then run `collector/Probe LMU.bat`.
   - "No responde": the port or the API is different. Check that `http://localhost:6397` opens
     in a browser while LMU is running.
2. Check what it printed: **car number** (with zeros, e.g. `007`), **class**, **driver**,
   **laps**, **last lap / sector times**, **in pits**.
3. Do a few laps including a pit stop with the collector running. Then check in
   RaceStrategy that the in-lap is marked, the out-lap has a `PIT_TIME`, and S1+S2+S3
   adds up to the lap time.
4. Anything wrong: send `logs/lmu-probe-*.json` (and the `lmu-raw-*.jsonl.gz` recording).
   Fix the mapping in `map_rest`. A recording can be replayed without the game:
   `python lmu_collector.py --replay logs/lmu-raw-….jsonl.gz --out <test folder>`.

Known unknowns: Safety Car vs FCY (both may show as `FCY`), the exact value of
`pitState`, whether `lastSectorTime2` is cumulative (assumed, as in rFactor 2), and
`currentEventTime` resetting between sessions. If the REST API turns out to be too
limited, the alternative is the rFactor 2 shared-memory plugin. That would be a new
source in `sources.py`; the rest stays the same.

## How it works

- `sources.py`: reads LMU, a recording or the simulation, and turns each reading into a
  `Snapshot` (state of the session and every car at that moment).
- `lap_builder.py`: detects each finish-line crossing and builds the lap row.
  - In-lap `B`: the car entered the pit lane during the lap and crossed the line inside it.
  - `PIT_TIME`: from pit entry to pit exit, set on the out-lap.
  - Flag at the line: the session flag when the car crosses the line.
  - S2 and S3: worked out from cumulative sectors.
  - Driver of each lap: the one seen most often on track during that lap.
- `writer.py`: append-only CSV and resume.
- Tests: `python -m pytest collector/tests`. These include a check that the app's importer
  and analysis read the collector's output.
