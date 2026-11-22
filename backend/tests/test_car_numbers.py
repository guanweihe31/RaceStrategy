import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from importer import padded_numbers, restore_padded_numbers, separate_shared_numbers  # noqa: E402

HEADER = "NUMBER;LAP_NUMBER;TEAM\n"


def _write(path, rows):
    path.write_text(HEADER + "".join(f"{n};{lap};{team}\n" for n, lap, team in rows), encoding="utf-8")
    return path


def _df(rows):
    return pd.DataFrame(rows, columns=["NUMBER", "LAP_NUMBER", "TEAM"]).astype({"NUMBER": "string"})


def test_padded_numbers_learned_from_event(tmp_path):
    fp2 = _write(tmp_path / "fp2.csv", [("007", 1, "Aston"), ("7", 1, "Toyota"), ("009", 1, "Aston")])
    found = padded_numbers([fp2], {"Other": ["001"]})
    assert found == {"Aston": {"007", "009"}, "Other": {"001"}}


def test_excel_stripped_numbers_restored_only_for_their_team():
    fp1 = _df([("7", 1, "Aston"), ("7", 1, "Toyota"), ("9", 1, "Aston"), ("8", 1, "Toyota")])
    df, notices = restore_padded_numbers(fp1, {"Aston": {"007", "009"}})
    assert df["NUMBER"].tolist() == ["007", "7", "009", "8"]
    assert len(notices) == 2
    # tras restaurar ya no hay número compartido: no se renombra a "7 (Aston)"
    df, shared = separate_shared_numbers(df)
    assert shared == [] and set(df["NUMBER"]) == {"007", "7", "009", "8"}


def test_nothing_known_keeps_numbers():
    df, notices = restore_padded_numbers(_df([("7", 1, "Toyota")]), {})
    assert df["NUMBER"].tolist() == ["7"] and notices == []
