from kernel_build_bot.db import Database


def test_serial_owner_and_revoke(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.allow_serial("3B15A800Y5D00000", 42, 1)
    assert db.verify_serial("3B15A800Y5D00000", 42)
    assert not db.verify_serial("3B15A800Y5D00000", 43)
    assert not db.verify_serial("3B15A800Y5D00001", 42)
    assert db.revoke_serial("3B15A800Y5D00000")
    assert not db.verify_serial("3B15A800Y5D00000", 42)

