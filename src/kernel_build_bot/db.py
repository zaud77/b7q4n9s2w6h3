from __future__ import annotations

import hashlib
import hmac
from pathlib import Path
import sqlite3
import time


class Database:
    def __init__(self, path: str, pepper: str):
        self.path = path
        self.pepper = pepper.encode()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _init(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS serials (
                    serial_hash TEXT PRIMARY KEY,
                    serial_tail TEXT NOT NULL,
                    owner_user_id INTEGER,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    created_by INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS builds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_user_id INTEGER NOT NULL,
                    serial_hash TEXT NOT NULL,
                    workflow TEXT NOT NULL,
                    inputs TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                """
            )

    def serial_hash(self, serial: str) -> str:
        return hmac.new(self.pepper, serial.encode("ascii"), hashlib.sha256).hexdigest()

    def allow_serial(self, serial: str, owner_user_id: int | None, created_by: int) -> None:
        digest = self.serial_hash(serial)
        with self._connect() as db:
            db.execute(
                """INSERT INTO serials(serial_hash, serial_tail, owner_user_id, enabled, created_at, created_by)
                   VALUES (?, ?, ?, 1, ?, ?)
                   ON CONFLICT(serial_hash) DO UPDATE SET
                     owner_user_id=excluded.owner_user_id, enabled=1""",
                (digest, serial[-4:], owner_user_id, int(time.time()), created_by),
            )

    def revoke_serial(self, serial: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                "UPDATE serials SET enabled=0 WHERE serial_hash=?",
                (self.serial_hash(serial),),
            )
            return cursor.rowcount > 0

    def verify_serial(self, serial: str, user_id: int) -> bool:
        with self._connect() as db:
            row = db.execute(
                "SELECT owner_user_id, enabled FROM serials WHERE serial_hash=?",
                (self.serial_hash(serial),),
            ).fetchone()
        return bool(row and row["enabled"] and (row["owner_user_id"] is None or row["owner_user_id"] == user_id))

    def list_serials(self) -> list[sqlite3.Row]:
        with self._connect() as db:
            return db.execute(
                "SELECT serial_tail, owner_user_id, enabled, created_at FROM serials ORDER BY created_at DESC"
            ).fetchall()

    def seconds_until_allowed(self, user_id: int, cooldown: int) -> int:
        with self._connect() as db:
            row = db.execute(
                "SELECT MAX(created_at) AS latest FROM builds WHERE telegram_user_id=?",
                (user_id,),
            ).fetchone()
        if not row or row["latest"] is None:
            return 0
        return max(0, cooldown - (int(time.time()) - int(row["latest"])))

    def record_build(self, user_id: int, serial: str, workflow: str, inputs: str) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO builds(telegram_user_id, serial_hash, workflow, inputs, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, self.serial_hash(serial), workflow, inputs, int(time.time())),
            )

