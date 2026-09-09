from kernel_build_bot.db import Database
from kernel_build_bot.bot import KernelBuildBot, defaults, parse_whitelist


def test_serial_owner_and_revoke(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.allow_serial("3B15A800Y5D00000", 42, 1)
    assert db.list_serials()[0]["serial_value"] == "3B15A800Y5D00000"
    assert db.verify_serial("3B15A800Y5D00000", 42)
    assert not db.verify_serial("3B15A800Y5D00000", 43)
    assert not db.verify_serial("3B15A800Y5D00001", 42)
    assert db.revoke_serial("3B15A800Y5D00000")
    assert not db.verify_serial("3B15A800Y5D00000", 42)


def test_pending_join_survives_database_reopen(tmp_path):
    path = str(tmp_path / "bot.db")
    db = Database(path, "test-pepper")
    db.set_pending_join(42, 4200)
    row = Database(path, "test-pepper").get_pending_join(42)
    assert row["user_chat_id"] == 4200
    db.clear_pending_join(42)
    assert db.get_pending_join(42) is None


def test_first_join_claims_unbound_serial(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.allow_serial("3B15AJ00S9700000", None, 1)
    assert db.claim_serial("3B15AJ00S9700000", 42)
    assert db.verify_serial("3B15AJ00S9700000", 42)
    assert not db.verify_serial("3B15AJ00S9700000", 43)
    assert not db.claim_serial("3B15AJ00S9700000", 43)


def test_parse_whitelist():
    rows, errors = parse_whitelist(
        "# comment\n3B15A800Y5D00000\n3B164V00HYR00000,42\n"
        "3B164V00HYR00000,42\nbad serial\n3B162200MZ300000,not-a-number\n"
    )
    assert rows == [
        ("3B15A800Y5D00000", None),
        ("3B164V00HYR00000", None),
        ("3B162200MZ300000", None),
    ]
    assert len(errors) == 1


def test_self_config_is_hidden_from_non_owner_build_menu():
    public_markup = KernelBuildBot.options_markup(None, defaults(), False)
    owner_markup = KernelBuildBot.options_markup(None, defaults(), True)
    public_labels = [button.text for row in public_markup.inline_keyboard for button in row]
    owner_labels = [button.text for row in owner_markup.inline_keyboard for button in row]
    assert not any("自用配置" in label for label in public_labels)
    assert any("自用配置" in label for label in owner_labels)
