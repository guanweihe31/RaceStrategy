import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from analysis import (  # noqa: E402
    analyse_laps, clean_air_degradation, default_reference, driver_race_summary,
    gap_to_reference,
)
from importer import import_data  # noqa: E402

HEADER = (
    "NUMBER; DRIVER_NUMBER; LAP_NUMBER; LAP_TIME; CROSSING_FINISH_LINE_IN_PIT; "
    "S1; S2; S3; ELAPSED; HOUR;DRIVER_NAME;PIT_TIME;CLASS;TEAM;FLAG_AT_FL;"
    "S1_SECONDS;S2_SECONDS;S3_SECONDS"
)


def _fmt(seconds: float) -> str:
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes)}:{rest:06.3f}"


def _rows(car, laps, start_elapsed=0.0):
    """laps: (s1, s2, s3, in_pit, pit_time, flag, driver_number, native_sectors)."""
    elapsed = start_elapsed
    out = []
    for i, (s1, s2, s3, pit, pit_time, flag, drv, native) in enumerate(laps, start=1):
        lap = s1 + s2 + s3
        elapsed += lap
        sectors = f"{s1:.3f};{s2:.3f};{s3:.3f}" if native else ";;"
        out.append(
            f"{car};{drv};{i};{_fmt(lap)};{'B' if pit else ''};{_fmt(s1)};{_fmt(s2)};{_fmt(s3)};"
            f"{_fmt(elapsed)};12:00:00.000;Driver {car}-{drv};{pit_time};HYPERCAR;Team {car};{flag};"
            f"{sectors}"
        )
    return out


def green(s1=30.0, s2=40.0, s3=30.0, drv=1, native=True):
    return (s1, s2, s3, False, "", "GF", drv, native)


@pytest.fixture(scope="module")
def analysed(tmp_path_factory):
    laps_a = (
        [green(native=False)]                       # lap 1: sectors only in M:SS.mmm
        + [green(s3=30.0 + 0.1 * i) for i in range(1, 6)]   # laps 2-6, +0.1 s/lap
        + [green(s2=41.0)]                          # lap 7: traffic in S2 (+1.0 s)
        + [(30.0, 40.0, 30.0, False, "", "FCY", 1, True)]   # lap 8: neutralized
        + [(30.0, 40.0, 45.0, True, "", "GF", 1, True)]     # lap 9: in lap
        + [(50.0, 40.0, 30.0, False, "0:20.000", "GF", 2, True)]  # lap 10: out lap, new driver
        + [green(drv=2) for _ in range(5)]          # laps 11-15
    )
    laps_b = [green(s1=31.0) for _ in range(15)]    # 1 s/lap slower, no stops
    path = tmp_path_factory.mktemp("analysis") / "23_Analysis_Race.CSV"
    path.write_text(
        "\n".join([HEADER] + _rows("1", laps_a) + _rows("2", laps_b)) + "\n", encoding="utf-8"
    )
    return analyse_laps(import_data(path))


def car(df, number):
    return df[df["NUMBER"] == number].set_index("LAP_NUMBER")


def test_sector_seconds_prefer_native_and_fall_back(analysed):
    a = car(analysed, "1")
    assert a.loc[1, "S1_SECONDS"] == pytest.approx(30.0)    # parsed from "0:30.000"
    assert a.loc[10, "S1_SECONDS"] == pytest.approx(50.0)   # native S1_SECONDS
    assert a.loc[10, "PIT_TIME_SECONDS"] == pytest.approx(20.0)
    assert a.loc[15, "ELAPSED_SECONDS"] == pytest.approx(a["LAP_TIME_SECONDS"].sum())


def test_lap_flags(analysed):
    a = car(analysed, "1")
    assert a.index[a["is_in_lap"]].tolist() == [9]
    assert a.index[a["is_out_lap"]].tolist() == [10]
    assert a.index[a["is_neutralized"]].tolist() == [8]


def test_stints_follow_driver_and_pit(analysed):
    a = car(analysed, "1")
    assert a["stint"].tolist() == [1] * 9 + [2] * 6
    assert a.loc[10, "stint_lap"] == 1
    assert car(analysed, "2")["stint"].nunique() == 1


def test_traffic_loss(analysed):
    a = car(analysed, "1")
    assert a.loc[7, "traffic_loss"] == pytest.approx(1.0, abs=0.15)
    assert not a.loc[7, "is_clean_air"]
    assert a.loc[3, "traffic_loss"] == 0                     # +0.1 s drift is not traffic
    assert np.isnan(a.loc[8, "traffic_loss"])                # neutralized: not comparable
    assert np.isnan(a.loc[10, "traffic_loss"])               # out lap


def test_clean_air_degradation(analysed):
    stints = clean_air_degradation(analysed, min_laps=5).set_index(["NUMBER", "stint"])
    first = stints.loc[("1", 1)]
    assert first["clean_laps"] == 6                          # laps 1-6 (7 traffic, 8 FCY, 9 in)
    assert first["slope"] == pytest.approx(0.1, abs=0.02)
    assert stints.loc[("1", 2), "clean_laps"] == 5
    assert stints.loc[("2", 1), "slope"] == pytest.approx(0.0)
    assert np.isnan(clean_air_degradation(analysed, min_laps=7).loc[0, "slope"])


def test_gap_to_reference(analysed):
    # car 1 loses more in the pit stop (+15 s in lap, +20 s out lap) than car 2's 1 s/lap
    assert default_reference(analysed) == "2"
    gaps = car(gap_to_reference(analysed, "1"), "2")["gap_to_reference"]
    assert gaps.loc[1] == pytest.approx(1.0)                 # car 2 is 1 s behind after lap 1
    assert gaps.loc[6] == pytest.approx(6.0 - 0.1 * 15)      # car 1's S3 drift: +0.1..+0.5
    assert gaps.loc[15] < 0                                  # ahead of car 1 after its stop
    with pytest.raises(KeyError):
        gap_to_reference(analysed, "99")


def test_driver_summary(analysed):
    summary = driver_race_summary(analysed, top_n=3).set_index(["NUMBER", "DRIVER_NUMBER"])
    one = summary.loc[("1", 1)]
    assert one["best_lap"] == pytest.approx(100.0)
    assert one["top_n_average"] == pytest.approx(100.1, abs=0.05)
    assert one["top_n_laps"] == 3
    assert one["total_traffic_loss"] == pytest.approx(1.0, abs=0.15)
    assert summary.loc[("2", 1), "std_dev"] == pytest.approx(0.0)
