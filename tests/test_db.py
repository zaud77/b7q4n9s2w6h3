from kernel_build_bot.db import Database
from kernel_build_bot.bot import (
    KernelBuildBot,
    SCRIPTS,
    apply_workflow_defaults,
    defaults,
    normalize_workflow_key,
    parse_whitelist,
    variant_markup,
    supports_self_config,
    WORKFLOWS,
)


def test_serial_owner_and_revoke(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.allow_serial("3B15A800Y5D00000", 42, 1)
    assert db.list_serials()[0]["serial_value"] == "3B15A800Y5D00000"
    assert db.serial_for_user(42) == "3B15A800Y5D00000"
    assert db.serial_for_user(43) is None
    assert db.verify_serial("3B15A800Y5D00000", 42)
    assert not db.verify_serial("3B15A800Y5D00000", 43)
    assert db.serial_is_allowed("3B15A800Y5D00000")
    assert not db.verify_serial("3B15A800Y5D00001", 42)
    assert not db.serial_is_allowed("3B15A800Y5D00001")
    assert db.revoke_serial("3B15A800Y5D00000")
    assert not db.verify_serial("3B15A800Y5D00000", 42)
    assert not db.serial_is_allowed("3B15A800Y5D00000")
    assert db.serial_for_user(42) is None


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


def test_workflow_binding_is_first_choice_and_build_count_is_bounded(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    assert db.workflow_for_user(42) is None
    assert db.bind_workflow(42, "623") == "623"
    assert db.bind_workflow(42, "658") == "623"
    assert db.workflow_for_user(42) == "623"
    db.record_build(42, "3B15A800Y5D00000", "build.yml", "{}")
    assert db.count_builds(42, 0, 4_102_444_800) == 1
    assert db.count_builds(43, 0, 4_102_444_800) == 0


def test_workflow_menu_and_oneplus15t_defaults():
    assert list(SCRIPTS) == ["623", "638t", "623m", "638a", "658", "658m"]
    assert [label for label, _ in SCRIPTS["623"][1].values()] == ["金标", "紫标"]
    assert [label for label, _ in SCRIPTS["638t"][1].values()] == ["金标", "紫标"]
    assert [label for label, _ in SCRIPTS["623m"][1].values()] == ["紫标"]
    assert [label for label, _ in SCRIPTS["658"][1].values()] == ["紫标"]
    assert "Find X9" in SCRIPTS["623m"][0]
    assert "天玑" not in SCRIPTS["623m"][0]
    assert "MT6993" not in SCRIPTS["623m"][0]
    assert "Pad 3 Pro" in SCRIPTS["658"][0]
    assert "骁龙" not in SCRIPTS["658"][0]
    assert "SM8850" not in SCRIPTS["658"][0]
    assert "Ace 6 Ultra" in SCRIPTS["658m"][0]
    assert "天玑" not in SCRIPTS["658m"][0]
    assert "MT6993" not in SCRIPTS["658m"][0]
    assert all(
        marker not in label
        for label, _ in WORKFLOWS.values()
        for marker in ("骁龙", "天玑", "SM8845", "SM8850", "MT6993")
    )
    assert WORKFLOWS["623g"][1] == "fastbuild_6.12.23_oneplus_15_hmbird_gold.yml"
    assert WORKFLOWS["638tp"][1] == "fastbuild_6.12.38_oneplus_15t_hmbird_purple.yml"
    assert WORKFLOWS["623mp"][1] == "fastbuild_6.12.23_mtk_hmbird_purple.yml"
    assert WORKFLOWS["638ag"][1] == "fastbuild_6.12.38_oneplus_ace6t_hmbird_gold.yml"
    assert WORKFLOWS["638ap"][1] == "fastbuild_6.12.38_oneplus_ace6t_hmbird_purple.yml"
    assert WORKFLOWS["658p"][1] == "fastbuild_6.12.58_hmbird_purple.yml"
    assert WORKFLOWS["658mg"][1] == "fastbuild_6.12.58_mtk_hmbird_gold.yml"
    assert WORKFLOWS["658mp"][1] == "fastbuild_6.12.58_mtk_hmbird_purple.yml"
    assert "623mg" not in WORKFLOWS
    assert "658g" not in WORKFLOWS

    options = apply_workflow_defaults("638tg", defaults())
    assert options["lz4_enable"] == "false"
    assert options["unicode_enable"] == "false"
    assert supports_self_config("623g")
    assert supports_self_config("623p")
    assert not supports_self_config("638tg")
    assert not supports_self_config("638tp")


def test_legacy_workflow_bindings_are_normalized():
    assert normalize_workflow_key("623") == "623"
    assert normalize_workflow_key("623g") == "623"
    assert normalize_workflow_key("638t") == "638t"
    assert normalize_workflow_key("638tg") == "638t"
    assert normalize_workflow_key("638a") == "638a"
    assert normalize_workflow_key("623mg") == "623m"
    assert normalize_workflow_key("623mp") == "623m"
    assert normalize_workflow_key("638ag") == "638a"
    assert normalize_workflow_key("638ap") == "638a"
    assert normalize_workflow_key("658g") == "658"
    assert normalize_workflow_key("658p") == "658"
    assert normalize_workflow_key("658mg") == "658m"
    assert normalize_workflow_key("658mp") == "658m"
    assert normalize_workflow_key(None) is None


def test_pending_build_job_survives_database_reopen(tmp_path):
    path = str(tmp_path / "bot.db")
    db = Database(path, "test-pepper")
    db.create_build_job(
        "request-1", 42, 42, "build.yml", '{"nomount_enable": "true"}'
    )
    job = Database(path, "test-pepper").pending_build_jobs()[0]
    assert job["request_id"] == "request-1"
    assert job["github_run_id"] is None
    assert job["inputs"] == '{"nomount_enable": "true"}'
    assert db.has_active_build_job()
    assert db.has_active_build_job(42)
    assert not db.has_active_build_job(43)
    db.update_build_job("request-1", "running", 1234)
    job = db.pending_build_jobs()[0]
    assert job["github_run_id"] == 1234
    db.update_build_job("request-1", "sent", 1234)
    assert db.pending_build_jobs() == []
    assert not db.has_active_build_job()
    assert not db.has_active_build_job(42)


def test_global_quota_reset_keeps_build_history(tmp_path):
    db = Database(str(tmp_path / "bot.db"), "test-pepper")
    db.record_build(42, "3B15A800Y5D00000", "build.yml", "{}")
    reset_at = db.reset_all_build_quotas()

    assert db.quota_reset_at() == reset_at
    assert db.count_builds(42, reset_at + 1, 4_102_444_800) == 0
    assert db.count_builds(42, 0, 4_102_444_800) == 1


def test_workflow_maintenance_flag_persists(tmp_path):
    path = str(tmp_path / "bot.db")
    db = Database(path, "test-pepper")
    assert not db.workflow_maintenance("623")
    db.set_workflow_maintenance("623", True)
    assert Database(path, "test-pepper").workflow_maintenance("623")
    db.set_workflow_maintenance("623", False)
    assert not db.workflow_maintenance("623")


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
    assert any("上一步" in label for label in public_labels)


def test_variant_back_button_can_be_hidden_for_bound_users():
    with_back = [button.text for row in variant_markup("623").inline_keyboard for button in row]
    without_back = [
        button.text
        for row in variant_markup("623", show_back=False).inline_keyboard
        for button in row
    ]
    assert any("上一步" in label for label in with_back)
    assert not any("上一步" in label for label in without_back)
