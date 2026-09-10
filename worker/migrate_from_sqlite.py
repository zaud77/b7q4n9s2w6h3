from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "data" / "bot.db"
CONFIG = ROOT / "worker" / "wrangler.jsonc"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def sql(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def main() -> None:
    settings = load_env()
    pepper = settings["SERIAL_PEPPER"].encode()
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row

    serials = list(db.execute(
        "SELECT serial_value,owner_user_id,enabled,created_at,created_by FROM serials "
        "WHERE serial_value IS NOT NULL ORDER BY created_at"
    ))
    hashes: list[str] = []
    for row in serials:
        serial = row["serial_value"]
        digest = hmac.new(pepper, serial.encode("ascii"), hashlib.sha256).hexdigest()
        hashes.append(digest)
        payload = json.dumps(
            {"serial": serial, "enabled": bool(row["enabled"])},
            separators=(",", ":"),
        )
        run(
            "pnpm.cmd", "exec", "wrangler", "kv", "key", "put",
            f"serial:{digest}", payload, "--binding", "SERIALS", "--remote",
            "--config", str(CONFIG),
        )
    run(
        "pnpm.cmd", "exec", "wrangler", "kv", "key", "put", "serial:index",
        json.dumps(hashes, separators=(",", ":")), "--binding", "SERIALS", "--remote",
        "--config", str(CONFIG),
    )

    statements = ["PRAGMA foreign_keys=OFF;"]
    statements += [
        "INSERT INTO serial_bindings(serial_hash,serial_value,owner_user_id,enabled,created_at,created_by) "
        f"VALUES({sql(hmac.new(pepper, row['serial_value'].encode('ascii'), hashlib.sha256).hexdigest())},"
        f"{sql(row['serial_value'])},{sql(row['owner_user_id'])},{sql(row['enabled'])},"
        f"{sql(row['created_at'])},{sql(row['created_by'])}) ON CONFLICT(serial_hash) DO UPDATE SET "
        "serial_value=excluded.serial_value,owner_user_id=excluded.owner_user_id,enabled=excluded.enabled;"
        for row in serials
    ]
    for table, columns in (
        ("pending_joins", ["telegram_user_id", "user_chat_id", "requested_at"]),
        ("workflow_bindings", ["telegram_user_id", "workflow_key", "bound_at"]),
        ("builds", ["id", "telegram_user_id", "serial_hash", "workflow", "inputs", "created_at"]),
        ("bot_state", ["key", "value"]),
    ):
        try:
            rows = list(db.execute(f"SELECT {','.join(columns)} FROM {table}"))
        except sqlite3.OperationalError:
            continue
        target_columns = ["workflow_file" if name == "workflow" else name for name in columns]
        for row in rows:
            statements.append(
                f"INSERT OR REPLACE INTO {table}({','.join(target_columns)}) VALUES("
                + ",".join(sql(row[name]) for name in columns) + ");"
            )
    jobs = list(db.execute(
        "SELECT request_id,telegram_user_id,chat_id,workflow_file,inputs,github_run_id,status,created_at,updated_at FROM build_jobs"
    ))
    for row in jobs:
        active = row["telegram_user_id"] if row["status"] in {"submitted", "running", "delivery_pending"} else None
        values = [row["request_id"], row["telegram_user_id"], active, row["chat_id"], row["workflow_file"], row["inputs"], row["github_run_id"], row["status"], row["created_at"], row["updated_at"]]
        statements.append(
            "INSERT OR REPLACE INTO build_jobs(request_id,telegram_user_id,active_user_id,chat_id,workflow_file,inputs,github_run_id,status,created_at,updated_at) VALUES("
            + ",".join(sql(value) for value in values) + ");"
        )

    temp_name = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", delete=False) as output:
            output.write("\n".join(statements))
            temp_name = output.name
        run(
            "pnpm.cmd", "exec", "wrangler", "d1", "execute", "oneplus-gki-build-bot",
            "--remote", "--file", temp_name, "--config", str(CONFIG),
        )
    finally:
        if temp_name:
            Path(temp_name).unlink(missing_ok=True)
    print(f"Migrated {len(serials)} serials, {len(jobs)} build jobs, and existing bindings.")


if __name__ == "__main__":
    main()
