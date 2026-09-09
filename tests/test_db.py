from kernel_build_bot.db import Database
from kernel_build_bot.bot import parse_whitelist


def test_serial_owner_and_revoke(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.allow_serial("3B15A800Y5D00000", 42, 1)
    assert db.verify_serial("3B15A800Y5D00000", 42)
    assert not db.verify_serial("3B15A800Y5D00000", 43)
    assert not db.verify_serial("3B15A800Y5D00001", 42)
    assert db.revoke_serial("3B15A800Y5D00000")
    assert not db.verify_serial("3B15A800Y5D00000", 42)


def test_parse_whitelist():
    rows, errors = parse_whitelist(
        "# comment\n3B15A800Y5D00000\n3B164V00HYR00000,42\n"
        "3B164V00HYR00000,42\nbad serial\n3B162200MZ300000,not-a-number\n"
    )
    assert rows == [("3B15A800Y5D00000", None), ("3B164V00HYR00000", 42)]
    assert len(errors) == 2
