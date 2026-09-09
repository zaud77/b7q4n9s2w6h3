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
                    serial_value TEXT,
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
                CREATE TABLE IF NOT EXISTS pending_joins (
                    telegram_user_id INTEGER PRIMARY KEY,
                    user_chat_id INTEGER NOT NULL,
                    requested_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workflow_bindings (
                    telegram_user_id INTEGER PRIMARY KEY,
                    workflow_key TEXT NOT NULL,
                    bound_at INTEGER NOT NULL
                );
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(serials)")}
            if "serial_value" not in columns:
                db.execute("ALTER TABLE serials ADD COLUMN serial_value TEXT")

    def serial_hash(self, serial: str) -> str:
        return hmac.new(self.pepper, serial.encode("ascii"), hashlib.sha256).hexdigest()

    def allow_serial(self, serial: str, owner_user_id: int | None, created_by: int) -> None:
        digest = self.serial_hash(serial)
        with self._connect() as db:
            db.execute(
                """INSERT INTO serials(serial_hash, serial_value, serial_tail, owner_user_id, enabled, created_at, created_by)
                   VALUES (?, ?, ?, ?, 1, ?, ?)
                   ON CONFLICT(serial_hash) DO UPDATE SET
                     serial_value=excluded.serial_value,
                     serial_tail=excluded.serial_tail,
                     owner_user_id=COALESCE(serials.owner_user_id, excluded.owner_user_id),
                     enabled=1""",
                (digest, serial, serial[-4:], owner_user_id, int(time.time()), created_by),
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

    def serial_for_user(self, user_id: int) -> str | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT serial_value FROM serials
                   WHERE owner_user_id=? AND enabled=1 AND serial_value IS NOT NULL
                   ORDER BY created_at DESC, rowid DESC LIMIT 1""",
                (user_id,),
            ).fetchone()
            return row["serial_value"] if row else None

    def workflow_for_user(self, user_id: int) -> str | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=?",
                (user_id,),
            ).fetchone()
            return row["workflow_key"] if row else None

    def bind_workflow(self, user_id: int, workflow_key: str) -> str:
        """Bind once and return the authoritative workflow key."""
        with self._connect() as db:
            db.execute(
                """INSERT OR IGNORE INTO workflow_bindings(telegram_user_id, workflow_key, bound_at)
                   VALUES (?, ?, ?)""",
                (user_id, workflow_key, int(time.time())),
            )
            row = db.execute(
                "SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=?",
                (user_id,),
            ).fetchone()
            return row["workflow_key"]

    def claim_serial(self, serial: str, user_id: int) -> bool:
        """Bind an enabled unclaimed serial to the first verified Telegram user."""
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE serials SET owner_user_id=?
                   WHERE serial_hash=? AND enabled=1
                     AND (owner_user_id IS NULL OR owner_user_id=?)""",
                (user_id, self.serial_hash(serial), user_id),
            )
            return cursor.rowcount > 0

    def list_serials(self) -> list[sqlite3.Row]:
        with self._connect() as db:
            return db.execute(
                "SELECT serial_value, serial_tail, owner_user_id, enabled, created_at "
                "FROM serials ORDER BY enabled DESC, serial_value COLLATE NOCASE, created_at DESC"
            ).fetchall()

    def set_pending_join(self, user_id: int, user_chat_id: int) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO pending_joins(telegram_user_id, user_chat_id, requested_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(telegram_user_id) DO UPDATE SET
                     user_chat_id=excluded.user_chat_id,
                     requested_at=excluded.requested_at""",
                (user_id, user_chat_id, int(time.time())),
            )

    def get_pending_join(self, user_id: int) -> sqlite3.Row | None:
        with self._connect() as db:
            return db.execute(
                "SELECT user_chat_id, requested_at FROM pending_joins WHERE telegram_user_id=?",
                (user_id,),
            ).fetchone()

    def clear_pending_join(self, user_id: int) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM pending_joins WHERE telegram_user_id=?", (user_id,))

    def seconds_until_allowed(self, user_id: int, cooldown: int) -> int:
        with self._connect() as db:
            row = db.execute(
                "SELECT MAX(created_at) AS latest FROM builds WHERE telegram_user_id=?",
                (user_id,),
            ).fetchone()
        if not row or row["latest"] is None:
            return 0
        return max(0, cooldown - (int(time.time()) - int(row["latest"])))

    def count_builds(self, user_id: int, since: int, before: int) -> int:
        with self._connect() as db:
            row = db.execute(
                """SELECT COUNT(*) AS total FROM builds
                   WHERE telegram_user_id=? AND created_at>=? AND created_at<?""",
                (user_id, since, before),
            ).fetchone()
            return int(row["total"])

    def record_build(self, user_id: int, serial: str, workflow: str, inputs: str) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO builds(telegram_user_id, serial_hash, workflow, inputs, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, self.serial_hash(serial), workflow, inputs, int(time.time())),
            )
