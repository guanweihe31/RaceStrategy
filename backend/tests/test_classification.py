import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from classification import gap_value, hour_of, load_classification, race_time  # noqa: E402
from importer import file_kind  # noqa: E402

HEADER = "POSITION;NUMBER;TEAM;DRIVER_1;DRIVER_2;CLASS;STATUS;LAPS;TOTAL_TIME;GAP_FIRST;FL_LAPNUM;FL_TIME;\n"


def _hour(tmp_path, hour, rows):
    path = tmp_path / f"03_Classification_Race_Hour {hour}.CSV"
    path.write_text(HEADER + "".join(";".join(map(str, r)) + ";\n" for r in rows), encoding="utf-8")
    return path


def test_time_formats():
    assert race_time("24:03'01.030") == pytest.approx(24 * 3600 + 181.03)
    assert race_time("3'25.155") == pytest.approx(205.155)
    assert race_time("10.913") == pytest.approx(10.913)
    assert race_time("") is None
    assert gap_value("1 Lap") == (None, 1)
    assert gap_value("12 Laps") == (None, 12)
    assert gap_value("10.913")[0] == pytest.approx(10.913)
    assert hour_of(Path("03_Classification_Race_Hour 17.CSV"), 0) == 17


def test_file_kind(tmp_path):
    analysis = tmp_path / "a.CSV"
    analysis.write_text("NUMBER; DRIVER_NUMBER; LAP_NUMBER; LAP_TIME;\n7;1;1;1:40.000;\n", encoding="utf-8")
    other = tmp_path / "o.CSV"
    other.write_text("FOO;BAR\n1;2\n", encoding="utf-8")
    assert file_kind(analysis) == "analysis"
    assert file_kind(_hour(tmp_path, 1, [(1, 7, "Toyota", "A", "B", "HYPERCAR", "Classified", 10, "0:35'00.000", "", 5, "3'25.000")])) == "classification"
    assert file_kind(other) == "unknown"


def test_load_classification_class_positions_and_leader_delta(tmp_path):
    paths = [
        _hour(tmp_path, 2, [
            (1, 7, "Toyota", "A", "B", "HYPERCAR", "Running", 20, "1:00'00.000", "", 5, "3'25.000"),
            (2, 92, "Porsche GT", "C", "", "LMGT3", "Running", 18, "1:00'30.000", "2 Laps", 7, "3'55.000"),
            (3, 8, "Toyota", "D", "", "HYPERCAR", "Running", 20, "1:00'10.000", "10.000", 6, "3'26.000"),
        ]),
        _hour(tmp_path, 1, [
            (1, 8, "Toyota", "D", "", "HYPERCAR", "Running", 10, "0:30'00.000", "", 3, "3'27.000"),
        ]),
    ]
    df = load_classification(paths)
    assert sorted(df["HOUR"].unique()) == [1, 2]
    h2 = df[df["HOUR"] == 2].set_index("NUMBER")
    assert h2.loc["92", "CLASS_POSITION"] == 1          # líder de LMGT3
    assert h2.loc["8", "CLASS_POSITION"] == 2
    assert h2.loc["92", "LAPS_DOWN"] == 2
    assert h2.loc["8", "LEADER_DELTA"] == pytest.approx(10.0)   # mismas vueltas: el gap real
    assert h2.loc["7", "LEADER_DELTA"] == pytest.approx(0.0)
