from __future__ import annotations

from dataclasses import dataclass
import os


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    telegram_token: str
    required_channel_id: int | str
    required_channel_url: str
    github_token: str
    github_repo: str
    github_ref: str
    serial_pepper: str
    database_path: str
    admin_user_ids: frozenset[int]
    cooldown_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        admins = frozenset(
            int(item.strip())
            for item in _required("ADMIN_USER_IDS").split(",")
            if item.strip()
        )
        channel_id_raw = _required("REQUIRED_CHANNEL_ID")
        channel_id: int | str = int(channel_id_raw) if channel_id_raw.lstrip("-").isdigit() else channel_id_raw
        return cls(
            telegram_token=_required("TELEGRAM_BOT_TOKEN"),
            required_channel_id=channel_id,
            required_channel_url=os.environ.get("REQUIRED_CHANNEL_URL", "").strip(),
            github_token=_required("GITHUB_TOKEN"),
            github_repo=os.environ.get("GITHUB_REPO", "cvhhji/oneplus_sm8850_hmbird").strip(),
            github_ref=os.environ.get("GITHUB_REF", "main").strip(),
            serial_pepper=_required("SERIAL_PEPPER"),
            database_path=os.environ.get("DATABASE_PATH", "data/bot.db").strip(),
            admin_user_ids=admins,
            cooldown_seconds=int(os.environ.get("BUILD_COOLDOWN_SECONDS", "600")),
        )
