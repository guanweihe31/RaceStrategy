import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend" / "src"))

from lap_builder import CarState, LapBuilder, SessionState, Snapshot, fmt_time  # noqa: E402
from sources import car_number, map_rest, wec_class  # noqa: E402
from writer import AlKamelWriter  # noqa: E402


def snap(t, flag="GF", **car):
    base = dict(slot="0", number="007", team="Aston", vehicle="Valkyrie", car_class="HYPERCAR",
                driver="A", laps_completed=0, last_lap=None, last_s1=None, last_s2_cumulative=None,
                in_pits=False)
    base.update(car)
    return Snapshot(SessionState(time=t, session="RACE", track="Le Mans", flag=flag, track_length=13626),
                    [CarState(**base)], wall_clock=datetime(2026, 6, 13, 16, 0, 0))


def test_fmt_time():
    assert fmt_time(92.84) == "1:32.840"
    assert fmt_time(3692.84) == "1:01:32.840"
    assert fmt_time(None) == ""


def test_laps_sectors_pit_and_flags():
    b = LapBuilder()
    rows = []
    rows += b.update(snap(0, laps_completed=0))
    rows += b.update(snap(205, laps_completed=1, last_lap=205.0, last_s1=60.0, last_s2_cumulative=135.0))
    assert len(rows) == 1
    r = rows[0]
    assert (r["NUMBER"], r["LAP_NUMBER"], r["LAP_TIME"]) == ("007", "1", "3:25.000")
    assert (r["S1_SECONDS"], r["S2_SECONDS"], r["S3_SECONDS"]) == ("60.000", "75.000", "70.000")
    assert r["FLAG_AT_FL"] == "GF" and r["CROSSING_FINISH_LINE_IN_PIT"] == "" and r["PIT_TIME"] == ""
    assert r["KPH"] == f"{13626 / 205 * 3.6:.1f}"

    # vuelta 2: entra al pit lane y cruza la meta dentro (bajo FCY) -> "B"
    b.update(snap(400, laps_completed=1, in_pits=True))
    rows = b.update(snap(420, flag="FCY", laps_completed=2, last_lap=215.0, in_pits=True))
    assert rows[0]["CROSSING_FINISH_LINE_IN_PIT"] == "B" and rows[0]["FLAG_AT_FL"] == "FCY"

    # vuelta 3: relevo, sale a los 470 s -> PIT_TIME 70 s en la vuelta de salida
    b.update(snap(470, laps_completed=2, in_pits=False, driver="B"))
    rows = b.update(snap(700, laps_completed=3, last_lap=280.0, driver="B"))
    r = rows[0]
    assert r["PIT_TIME"] == "1:10.000" and r["CROSSING_FINISH_LINE_IN_PIT"] == ""
    assert (r["DRIVER_NAME"], r["DRIVER_NUMBER"]) == ("B", "2")
    assert r["ELAPSED"] == fmt_time(205 + 215 + 280)


def test_driver_swap_at_pit_crossing_keeps_in_lap_with_outgoing_driver():
    b = LapBuilder()
    b.update(snap(0, laps_completed=0, driver="A"))
    b.update(snap(100, laps_completed=0, driver="A"))
    b.update(snap(190, laps_completed=0, driver="A", in_pits=True))
    # el juego ya muestra al piloto nuevo en el mismo instante en que cruza en el pit lane
    rows = b.update(snap(205, laps_completed=1, last_lap=205.0, driver="B", in_pits=True))
    assert (rows[0]["DRIVER_NAME"], rows[0]["DRIVER_NUMBER"], rows[0]["CROSSING_FINISH_LINE_IN_PIT"]) == ("A", "1", "B")
    b.update(snap(270, laps_completed=1, driver="B", in_pits=False))
    rows = b.update(snap(480, laps_completed=2, last_lap=275.0, driver="B"))
    assert (rows[0]["DRIVER_NAME"], rows[0]["DRIVER_NUMBER"]) == ("B", "2")


def test_missing_lap_time_falls_back_to_crossing_delta_and_skips_known():
    b = LapBuilder(known_laps={"007": 1})
    b.update(snap(0, laps_completed=0))
    assert b.update(snap(205, laps_completed=1, last_lap=205.0)) == []  # ya estaba escrita
    rows = b.update(snap(412, laps_completed=2, last_lap=None))
    assert rows[0]["LAP_TIME"] == "3:27.000"
    rows = b.update(snap(1000, laps_completed=5, last_lap=200.0))
    assert b.missed["007"] == 2


def test_map_rest_rfactor_fields():
    session = {"session": "RACE1", "trackName": "Circuit de la Sarthe", "currentEventTime": 1234.5,
               "gamePhase": 6, "yellowFlagState": "PITS_CLOSED", "lapDistance": 13626.0}
    standings = [{"slotID": 3, "vehicleName": "#007 Aston Martin THOR Team", "carClass": "Hyper",
                  "driverName": "Harry TINCKNELL", "lapsCompleted": 12, "lastLapTime": 207.1,
                  "lastSectorTime1": 61.0, "lastSectorTime2": 137.5, "pitState": "NONE",
                  "inGarageStall": False, "carVelocity": {"velocity": 80.0}}]
    s = map_rest(session, standings)
    assert s.session.flag == "FCY" and s.session.time == pytest.approx(1234.5)
    car = s.cars[0]
    assert (car.number, car.car_class, car.laps_completed, car.in_pits) == ("007", "HYPERCAR", 12, False)
    assert car.speed == pytest.approx(80.0)
    assert wec_class("GT3") == "LMGT3" and car_number({"carNumber": "007"}) == "007"


def test_writer_resumes_without_duplicates(tmp_path):
    path = tmp_path / "x" / "Race.CSV"
    w = AlKamelWriter(path)
    w.write([{"NUMBER": "7", "LAP_NUMBER": "1", "LAP_TIME": "3:25.000"}])
    w.close()
    w2 = AlKamelWriter(path)
    assert w2.known_laps == {"7": 1}
    w2.close()
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("NUMBER;DRIVER_NUMBER") and len(lines) == 2


def test_written_file_is_readable_by_the_app(tmp_path):
    from analysis import analyse_laps
    from importer import import_data

    b = LapBuilder()
    w = AlKamelWriter(tmp_path / "Race.CSV")
    b.update(snap(0, laps_completed=0))
    for lap in range(1, 8):
        w.write(b.update(snap(lap * 205, laps_completed=lap, last_lap=205.0 + lap * 0.1,
                              last_s1=60.0, last_s2_cumulative=135.0)))
    w.close()
    df = analyse_laps(import_data(tmp_path / "Race.CSV"))
    assert len(df) == 7 and df["NUMBER"].iloc[0] == "007"
    assert df["S3_SECONDS"].iloc[0] == pytest.approx(70.1)
