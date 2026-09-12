from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
import re
import secrets
import shutil
import sys
import tempfile
import time
import zipfile
from datetime import datetime, time as datetime_time, timedelta, timezone
from pathlib import Path

import httpx
from telegram import BotCommand, BotCommandScopeChat, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatMemberStatus
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ChatJoinRequestHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .config import Settings
from .db import Database

SERIAL_RE = re.compile(r"^[A-Za-z0-9._:-]{6,64}$")

SCRIPTS = {
    "623": (
        "6.12.23 · OnePlus 15",
        {
            "gold": ("金标", "623g"),
            "purple": ("紫标", "623p"),
        },
    ),
    "638t": (
        "6.12.38 · OnePlus 15T",
        {
            "gold": ("金标", "638tg"),
            "purple": ("紫标", "638tp"),
        },
    ),
    "623m": (
        "6.12.23 · 天玑",
        {
            "gold": ("金标", "623mg"),
            "purple": ("紫标", "623mp"),
        },
    ),
    "638a": (
        "6.12.38 · OnePlus Ace6T",
        {
            "gold": ("金标", "638ag"),
            "purple": ("紫标", "638ap"),
        },
    ),
    "658": (
        "6.12.58",
        {
            "gold": ("金标", "658g"),
            "purple": ("紫标", "658p"),
        },
    ),
    "658m": (
        "6.12.58 · 天玑",
        {
            "gold": ("金标", "658mg"),
            "purple": ("紫标", "658mp"),
        },
    ),
}
WORKFLOWS = {
    "623g": ("6.12.23 · OnePlus 15 · 金标", "fastbuild_6.12.23_oneplus_15_hmbird_gold.yml"),
    "623p": ("6.12.23 · OnePlus 15 · 紫标", "fastbuild_6.12.23_oneplus_15_hmbird_purple.yml"),
    "638tg": ("6.12.38 · OnePlus 15T · 金标", "fastbuild_6.12.38_oneplus_15t_hmbird_gold.yml"),
    "638tp": ("6.12.38 · OnePlus 15T · 紫标", "fastbuild_6.12.38_oneplus_15t_hmbird_purple.yml"),
    "638ag": ("6.12.38 · OnePlus Ace6T · 金标", "fastbuild_6.12.38_oneplus_ace6t_hmbird_gold.yml"),
    "638ap": ("6.12.38 · OnePlus Ace6T · 紫标", "fastbuild_6.12.38_oneplus_ace6t_hmbird_purple.yml"),
    "658g": ("6.12.58 · 金标", "fastbuild_6.12.58_hmbird_gold.yml"),
    "658p": ("6.12.58 · 紫标", "fastbuild_6.12.58_hmbird_purple.yml"),
    "623mg": ("6.12.23 · 天玑 · 金标", "fastbuild_6.12.23_mtk_hmbird_gold.yml"),
    "623mp": ("6.12.23 · 天玑 · 紫标", "fastbuild_6.12.23_mtk_hmbird_purple.yml"),
    "658mg": ("6.12.58 · 天玑 · 金标", "fastbuild_6.12.58_mtk_hmbird_gold.yml"),
    "658mp": ("6.12.58 · 天玑 · 紫标", "fastbuild_6.12.58_mtk_hmbird_purple.yml"),
}
WORKFLOW_SCRIPTS = {
    workflow_key: script_key
    for script_key, (_, variants) in SCRIPTS.items()
    for workflow_key in ([item[1] for item in variants.values()] if variants else [script_key])
}
ONEPLUS_15_WORKFLOW_KEYS = {"623g", "623p"}
ONEPLUS_15T_WORKFLOW_KEYS = {"638tg", "638tp"}
LEGACY_WORKFLOW_KEYS = {key: script_key for key, script_key in WORKFLOW_SCRIPTS.items()}

BOOL_LABELS = {
    "self_config": "自用配置",
    "susfs_enable": "SUSFS",
    "nomount_enable": "NoMount",
    "kpm_enable": "KPM / KPatch Next",
    "lz4_enable": "LZ4 + Zstd",
    "lz4kd_enable": "LZ4KD",
    "zarm_tool": "zarm 工具",
    "unicode_enable": "Unicode 修复",
    "better_net": "网络增强",
    "adios_enable": "ADIOS",
    "rekernel_enable": "Re-Kernel",
    "baseband_guard": "基带保护",
}

KSU_VALUES = ["resukisu", "sukisu", "ksunext", "ksu", "none"]
BBR_VALUES = ["false", "true", "default"]
DROID_VALUES = ["false", "standard", "extend"]
BUILD_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


def parse_whitelist(text: str) -> tuple[list[tuple[str, int | None]], list[str]]:
    rows: list[tuple[str, int | None]] = []
    errors: list[str] = []
    seen: set[str] = set()
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        serial = re.split(r"[,\t]", line, maxsplit=1)[0].strip()
        if not SERIAL_RE.fullmatch(serial):
            errors.append(f"第 {number} 行序列号格式无效")
            continue
        if serial in seen:
            continue
        seen.add(serial)
        rows.append((serial, None))
    return rows, errors


def defaults() -> dict[str, str]:
    values = {key: "false" for key in BOOL_LABELS}
    values.update(
        ksu_type="resukisu",
        lz4_enable="true",
        unicode_enable="true",
        bbr_enable="false",
        droidspaces_enable="false",
        ccache_update="false",
        ccache_debug="false",
    )
    return values


def apply_workflow_defaults(workflow_key: str, options: dict[str, str]) -> dict[str, str]:
    if workflow_key in ONEPLUS_15T_WORKFLOW_KEYS:
        options["lz4_enable"] = "false"
        options["unicode_enable"] = "false"
    return options


def supports_self_config(workflow_key: str) -> bool:
    return workflow_key in ONEPLUS_15_WORKFLOW_KEYS


def normalize_workflow_key(workflow_key: str | None) -> str | None:
    if workflow_key is None:
        return None
    return LEGACY_WORKFLOW_KEYS.get(workflow_key, workflow_key)


def script_markup() -> InlineKeyboardMarkup:
    keyboard = [
        [InlineKeyboardButton(label, callback_data=f"kernel:{key}")]
        for key, (label, _) in SCRIPTS.items()
    ]
    keyboard.append([InlineKeyboardButton("取消", callback_data="cancel")])
    return InlineKeyboardMarkup(keyboard)


def variant_markup(script_key: str) -> InlineKeyboardMarkup:
    variants = SCRIPTS[script_key][1]
    keyboard = [
        [InlineKeyboardButton(label, callback_data=f"variant:{script_key}:{variant_key}")]
        for variant_key, (label, _) in variants.items()
    ]
    keyboard.append([InlineKeyboardButton("取消", callback_data="cancel")])
    return InlineKeyboardMarkup(keyboard)


class KernelBuildBot:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = Database(settings.database_path, settings.serial_pepper)
        self._monitor_task: asyncio.Task | None = None

    def is_admin(self, user_id: int) -> bool:
        return user_id in self.settings.admin_user_ids

    async def reject_while_building(self, update: Update) -> bool:
        user = update.effective_user
        if user is None or not self.db.has_active_build_job(user.id):
            return False
        text = "当前正在构建内核，请等待本次构建完成。"
        if update.callback_query:
            await update.callback_query.answer(text, show_alert=True)
        elif update.effective_message:
            await update.effective_message.reply_text(text)
        return True

    def daily_build_count(self, user_id: int) -> int:
        now = datetime.now(BUILD_TIMEZONE)
        start = datetime.combine(now.date(), datetime_time.min, tzinfo=BUILD_TIMEZONE)
        end = start + timedelta(days=1)
        reset_at = self.db.quota_reset_at()
        quota_start = max(int(start.timestamp()), reset_at + 1 if reset_at else 0)
        return self.db.count_builds(user_id, quota_start, int(end.timestamp()))

    async def is_channel_member(self, context: ContextTypes.DEFAULT_TYPE, user_id: int) -> bool:
        try:
            member = await context.bot.get_chat_member(self.settings.required_channel_id, user_id)
        except Exception:
            logging.exception("channel membership check failed")
            return False
        return member.status in {
            ChatMemberStatus.MEMBER,
            ChatMemberStatus.ADMINISTRATOR,
            ChatMemberStatus.OWNER,
        }

    async def create_join_request_invite(self, context: ContextTypes.DEFAULT_TYPE, user_id: int) -> str:
        invite = await context.bot.create_chat_invite_link(
            self.settings.required_channel_id,
            name=f"verified-{user_id}-{int(time.time())}",
            creates_join_request=True,
        )
        return invite.invite_link

    async def sync_user_commands(self, context: ContextTypes.DEFAULT_TYPE, user_id: int, bound: bool) -> None:
        if self.is_admin(user_id):
            commands = [
                BotCommand("start", "启动机器人"),
                BotCommand("build", "构建绑定设备的内核"),
                BotCommand("buildfor", "为指定白名单序列号构建"),
                BotCommand("allow", "添加白名单序列号"),
                BotCommand("revoke", "撤销白名单序列号"),
                BotCommand("allowed", "查看完整白名单"),
                BotCommand("joinlink", "获取入群验证链接"),
            ]
        elif bound:
            commands = [
                BotCommand("start", "启动机器人"),
                BotCommand("build", "构建绑定设备的内核"),
            ]
        else:
            commands = [
                BotCommand("start", "验证序列号"),
                BotCommand("join", "验证序列号并申请入群"),
            ]
        try:
            await context.bot.set_my_commands(
                commands,
                scope=BotCommandScopeChat(chat_id=user_id),
            )
        except Exception:
            logging.exception("failed to set commands for user %s", user_id)

    async def recover_join_approval(
        self,
        context: ContextTypes.DEFAULT_TYPE,
        update: Update,
        user_id: int,
    ) -> None:
        if await self.is_channel_member(context, user_id):
            self.db.clear_pending_join(user_id)
            context.user_data.clear()
            await update.effective_message.reply_text("你已经是频道成员，序列号已绑定，可直接使用 /build。")
            return
        try:
            invite_link = await self.create_join_request_invite(context, user_id)
        except Exception:
            logging.exception("failed to create recovery channel invite link")
            await update.effective_message.reply_text(
                "序列号已通过，但批准入群失败，请联系管理员。"
            )
            return
        await update.effective_message.reply_text(
            f"原加入申请已失效。请使用以下链接重新提交加入申请，机器人会自动批准：\n{invite_link}"
        )

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        user = update.effective_user
        bound_serial = self.db.serial_for_user(user.id)
        if self.is_admin(user.id):
            await self.sync_user_commands(context, user.id, True)
            await update.effective_message.reply_text(
                "OnePlus GKI 构建机器人已启动；发送 /build 可选择内核版本和功能。"
            )
            return
        if await self.is_channel_member(context, user.id):
            if bound_serial:
                context.user_data.clear()
                await self.sync_user_commands(context, user.id, True)
                await update.effective_message.reply_text(
                    "OnePlus GKI 构建机器人已启动；发送 /build 可选择内核版本和功能。"
                )
            else:
                context.user_data.clear()
                context.user_data["awaiting_join_serial"] = True
                await self.sync_user_commands(context, user.id, False)
                await update.effective_message.reply_text("你已是群组成员。请输入设备序列号完成绑定：")
            return
        if bound_serial:
            context.user_data.clear()
            await self.sync_user_commands(context, user.id, True)
            invite_link = await self.create_join_request_invite(context, user.id)
            await update.effective_message.reply_text(
                f"序列号已绑定。请使用以下链接申请进入群组，机器人会自动批准：\n{invite_link}"
            )
        else:
            context.user_data.clear()
            context.user_data["awaiting_join_serial"] = True
            await self.sync_user_commands(context, user.id, False)
            await update.effective_message.reply_text("请输入设备序列号，验证通过后才能进入群组：")

    async def join(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        context.user_data.clear()
        context.user_data["awaiting_join_serial"] = True
        await update.effective_message.reply_text("请输入设备序列号：")

    async def join_request(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        request = update.chat_join_request
        if request.chat.id != self.settings.required_channel_id:
            return
        if self.db.has_active_build_job(request.from_user.id):
            await context.bot.send_message(
                request.user_chat_id, "当前正在构建内核，请等待本次构建完成后重新申请。"
            )
            return
        self.db.set_pending_join(request.from_user.id, request.user_chat_id)
        context.user_data.clear()
        context.user_data["awaiting_join_serial"] = True
        await context.bot.send_message(request.user_chat_id, "请输入设备序列号：")

    async def build(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        user = update.effective_user
        if not self.is_admin(user.id) and not self.db.serial_for_user(user.id):
            await self.sync_user_commands(context, user.id, False)
            await update.effective_message.reply_text("请先使用 /start 绑定设备序列号。")
            return
        if not await self.is_channel_member(context, user.id):
            await update.effective_message.reply_text("尚未通过入群验证，请先使用 /start。")
            return
        serial = self.db.serial_for_user(user.id)
        if not serial:
            await update.effective_message.reply_text("当前 Telegram 账号尚未绑定有效序列号，请先使用 /start。")
            return
        if (
            not self.is_admin(user.id)
            and self.daily_build_count(user.id) >= self.settings.daily_build_limit
        ):
            await update.effective_message.reply_text(
                f"今天已达到 {self.settings.daily_build_limit} 次构建上限，请在北京时间次日再试。"
            )
            return
        context.user_data.clear()
        # The owner can choose any workflow on every build. Regular users keep
        # their first selected workflow binding.
        bound_workflow = (
            None
            if self.is_admin(user.id)
            else normalize_workflow_key(self.db.workflow_for_user(user.id))
        )
        options = defaults()
        context.user_data.update(serial=serial, options=options)
        if bound_workflow:
            if bound_workflow not in SCRIPTS:
                await update.effective_message.reply_text("已绑定的构建脚本当前不可用，请联系管理员。")
                return
            variants = SCRIPTS[bound_workflow][1]
            workflow_keys = [workflow_key for _, workflow_key in variants.values()] if variants else [bound_workflow]
            if any(self.db.workflow_maintenance(workflow_key) for workflow_key in workflow_keys):
                await update.effective_message.reply_text(
                    f"{SCRIPTS[bound_workflow][0]} 正在建立持久缓存，暂时不能提交构建。"
                )
                return
            if not variants:
                context.user_data["workflow"] = bound_workflow
                apply_workflow_defaults(bound_workflow, options)
            await update.effective_message.reply_text(
                f"已绑定：{SCRIPTS[bound_workflow][0]}\n请选择风驰版本："
                if variants
                else f"已绑定：{SCRIPTS[bound_workflow][0]}\n请选择功能：",
                reply_markup=variant_markup(bound_workflow)
                if variants
                else self.options_markup(options, self.is_admin(user.id) and supports_self_config(bound_workflow)),
            )
            return
        prompt = "请选择本次构建脚本：" if self.is_admin(user.id) else "首次构建，请选择要绑定的构建脚本："
        await update.effective_message.reply_text(prompt, reply_markup=script_markup())

    async def build_for(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        user = update.effective_user
        if not self.is_admin(user.id):
            await update.effective_message.reply_text("无权使用管理员命令。")
            return
        if not context.args or not SERIAL_RE.fullmatch(context.args[0]):
            await update.effective_message.reply_text("用法：/buildfor 序列号")
            return
        serial = context.args[0]
        if not self.db.serial_is_allowed(serial):
            await update.effective_message.reply_text("该序列号不在启用的白名单中。")
            return
        if not await self.is_channel_member(context, user.id):
            await update.effective_message.reply_text("所有者账号当前不在构建频道中。")
            return
        if update.effective_chat.id != user.id:
            await update.effective_message.reply_text("请在与机器人的私聊中使用 /buildfor。")
            return
        context.user_data.clear()
        context.user_data.update(
            serial=serial,
            options=defaults(),
            owner_directed_build=True,
            delivery_chat_id=user.id,
        )
        await update.effective_message.reply_text(
            f"为序列号 {serial} 构建；完成后的产物只发送给你。\n请选择构建脚本：",
            reply_markup=script_markup(),
        )

    async def text_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if context.user_data is None or not context.user_data.get("awaiting_join_serial"):
            return
        serial = update.effective_message.text.strip()
        if not SERIAL_RE.fullmatch(serial):
            await update.effective_message.reply_text("序列号格式无效，请重新输入。")
            return
        user_id = update.effective_user.id
        pending = self.db.get_pending_join(user_id)
        if not self.db.claim_serial(serial, user_id):
            if pending:
                try:
                    await context.bot.decline_chat_join_request(
                        self.settings.required_channel_id, user_id
                    )
                except Exception:
                    logging.exception("failed to decline channel join request")
                self.db.clear_pending_join(user_id)
            context.user_data.clear()
            await self.sync_user_commands(context, user_id, False)
            await update.effective_message.reply_text(
                "序列号验证未通过，已拒绝本次入群申请。请使用 /start 重新验证。"
            )
            return
        await self.sync_user_commands(context, user_id, True)
        if context.user_data.get("awaiting_join_serial"):
            if await self.is_channel_member(context, user_id):
                context.user_data.clear()
                await update.effective_message.reply_text("序列号已绑定，频道成员身份验证通过，可使用 /build。")
                return
            if not pending:
                await update.effective_message.reply_text(
                    "序列号验证通过。请先打开管理员发送的频道申请链接并提交加入请求，机器人收到后会自动验证。"
                )
                return
            try:
                await context.bot.approve_chat_join_request(self.settings.required_channel_id, user_id)
            except Exception:
                logging.exception("failed to approve channel join request")
                await self.recover_join_approval(context, update, user_id)
                return
            self.db.clear_pending_join(user_id)
            context.user_data.clear()
            await update.effective_message.reply_text("序列号验证通过，已批准进入频道。加入后可使用 /build。")
            return

    def options_markup(self, options: dict[str, str], show_self_config: bool) -> InlineKeyboardMarkup:
        rows = []
        for key, label in BOOL_LABELS.items():
            if key == "self_config" and not show_self_config:
                continue
            mark = "✅" if options[key] == "true" else "⬜"
            rows.append([InlineKeyboardButton(f"{mark} {label}", callback_data=f"toggle:{key}")])
        rows.extend(
            [
                [InlineKeyboardButton(f"KernelSU：{options['ksu_type']}", callback_data="cycle:ksu_type")],
                [InlineKeyboardButton(f"BBR/Brutal：{options['bbr_enable']}", callback_data="cycle:bbr_enable")],
                [InlineKeyboardButton(f"Droidspaces：{options['droidspaces_enable']}", callback_data="cycle:droidspaces_enable")],
                [InlineKeyboardButton("开始构建", callback_data="dispatch"), InlineKeyboardButton("取消", callback_data="cancel")],
            ]
        )
        return InlineKeyboardMarkup(rows)

    async def callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if await self.reject_while_building(update):
            return
        await query.answer()
        if not self.is_admin(query.from_user.id) and not self.db.serial_for_user(query.from_user.id):
            await self.sync_user_commands(context, query.from_user.id, False)
            await query.edit_message_text("请先使用 /start 绑定设备序列号。")
            return
        data = query.data
        if data == "cancel":
            context.user_data.clear()
            await query.edit_message_text("已取消。")
            return
        if data.startswith("kernel:"):
            key = data.split(":", 1)[1]
            if key not in SCRIPTS or "serial" not in context.user_data:
                await query.edit_message_text("会话已失效，请重新使用 /build。")
                return
            if not SCRIPTS[key][1] and self.db.workflow_maintenance(key):
                await query.answer("该内核正在建立持久缓存，请稍后再试", show_alert=True)
                return
            if not self.is_admin(query.from_user.id):
                if normalize_workflow_key(self.db.bind_workflow(query.from_user.id, key)) != key:
                    await query.answer("该账号已绑定其他构建脚本", show_alert=True)
                    await query.edit_message_text("绑定状态已变化，请重新使用 /build。")
                    return
            variants = SCRIPTS[key][1]
            if variants:
                context.user_data.pop("workflow", None)
                await query.edit_message_text(
                    f"已选择：{SCRIPTS[key][0]}\n请选择风驰版本：",
                    reply_markup=variant_markup(key),
                )
                return
            context.user_data["workflow"] = key
            apply_workflow_defaults(key, context.user_data["options"])
            await query.edit_message_text(
                f"已选择：{WORKFLOWS[key][0]}\n继续选择功能：",
                reply_markup=self.options_markup(
                    context.user_data["options"],
                    self.is_admin(query.from_user.id) and supports_self_config(key),
                ),
            )
            return
        if data.startswith("variant:"):
            _, script_key, variant_key = data.split(":", 2)
            variants = SCRIPTS.get(script_key, (None, None))[1]
            if not variants or variant_key not in variants or "serial" not in context.user_data:
                await query.edit_message_text("会话已失效，请重新使用 /build。")
                return
            workflow_key = variants[variant_key][1]
            if self.db.workflow_maintenance(workflow_key):
                await query.answer("该内核正在建立持久缓存，请稍后再试", show_alert=True)
                return
            context.user_data["workflow"] = workflow_key
            apply_workflow_defaults(workflow_key, context.user_data["options"])
            await query.edit_message_text(
                f"已选择：{WORKFLOWS[workflow_key][0]}\n继续选择功能：",
                reply_markup=self.options_markup(
                    context.user_data["options"],
                    self.is_admin(query.from_user.id) and supports_self_config(workflow_key),
                ),
            )
            return
        options = context.user_data.get("options")
        if not options:
            await query.edit_message_text("会话已失效，请重新使用 /build。")
            return
        if data.startswith("toggle:"):
            key = data.split(":", 1)[1]
            if key not in BOOL_LABELS:
                return
            if key == "self_config" and not self.is_admin(query.from_user.id):
                options["self_config"] = "false"
                await query.answer("该配置仅限所有者使用", show_alert=True)
                return
            new_value = "false" if options[key] == "true" else "true"
            if key == "zarm_tool" and new_value == "true" and options["lz4kd_enable"] != "true":
                await query.answer("请先开启 LZ4KD", show_alert=True)
                return
            options[key] = new_value
            if new_value == "true" and key == "susfs_enable":
                options["nomount_enable"] = "false"
            if new_value == "true" and key == "nomount_enable":
                options["susfs_enable"] = "false"
            if key == "lz4kd_enable" and new_value == "false":
                options["zarm_tool"] = "false"
        elif data.startswith("cycle:"):
            key = data.split(":", 1)[1]
            choices = {"ksu_type": KSU_VALUES, "bbr_enable": BBR_VALUES, "droidspaces_enable": DROID_VALUES}.get(key)
            if not choices:
                return
            options[key] = choices[(choices.index(options[key]) + 1) % len(choices)]
        elif data == "dispatch":
            await self.dispatch(query, context)
            return
        workflow_key = context.user_data.get("workflow", "")
        await query.edit_message_reply_markup(
            reply_markup=self.options_markup(
                options,
                self.is_admin(query.from_user.id) and supports_self_config(workflow_key),
            )
        )

    async def dispatch(self, query, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id = query.from_user.id
        if self.db.has_active_build_job(user_id):
            await query.answer("当前正在构建内核，请等待本次构建完成。", show_alert=True)
            return
        serial = context.user_data.get("serial", "")
        workflow_key = context.user_data.get("workflow", "")
        owner_directed = bool(context.user_data.get("owner_directed_build"))
        serial_authorized = (
            self.is_admin(user_id) and owner_directed and self.db.serial_is_allowed(serial)
        ) or self.db.verify_serial(serial, user_id)
        delivery_chat_id = int(context.user_data.get("delivery_chat_id", user_id))
        owner_delivery_valid = not owner_directed or (
            self.is_admin(user_id) and delivery_chat_id == user_id
        )
        if (
            not await self.is_channel_member(context, user_id)
            or not serial_authorized
            or not owner_delivery_valid
        ):
            context.user_data.clear()
            await query.edit_message_text("最终授权检查失败，未触发构建。")
            return
        if not self.is_admin(user_id):
            wait = self.db.seconds_until_allowed(user_id, self.settings.cooldown_seconds)
            if wait:
                await query.answer(f"请在 {wait} 秒后再构建", show_alert=True)
                return
        if (
            not self.is_admin(user_id)
            and self.daily_build_count(user_id) >= self.settings.daily_build_limit
        ):
            await query.answer(
                f"今天已达到 {self.settings.daily_build_limit} 次构建上限",
                show_alert=True,
            )
            return
        if workflow_key not in WORKFLOWS:
            await query.edit_message_text("未选择有效工作流。")
            return
        if self.db.workflow_maintenance(workflow_key):
            await query.edit_message_text(
                f"{WORKFLOWS[workflow_key][0]} 正在建立持久缓存，暂时不能提交构建。"
            )
            return
        bound_script = WORKFLOW_SCRIPTS.get(workflow_key, workflow_key)
        if (
            not self.is_admin(user_id)
            and normalize_workflow_key(self.db.workflow_for_user(user_id)) != bound_script
        ):
            await query.edit_message_text("构建脚本绑定复核失败，请重新使用 /build。")
            return
        _, workflow = WORKFLOWS[workflow_key]
        inputs = dict(context.user_data["options"])
        if not supports_self_config(workflow_key):
            inputs.pop("self_config", None)
        elif not self.is_admin(user_id):
            # Enforce owner-only configuration at dispatch time too, including
            # stale keyboards and forged callback payloads.
            inputs["self_config"] = "false"
        inputs["device_serial"] = serial
        request_id = secrets.token_hex(8)
        inputs["build_request_id"] = request_id
        if self.settings.github_use_gh_cli:
            args = [
                "gh", "workflow", "run", workflow,
                "--repo", self.settings.github_repo,
                "--ref", self.settings.github_ref,
            ]
            for key, value in inputs.items():
                args.extend(["-f", f"{key}={value}"])
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            if process.returncode != 0:
                logging.error(
                    "gh workflow run failed (%s): %s %s",
                    process.returncode,
                    stdout.decode(errors="replace"),
                    stderr.decode(errors="replace"),
                )
                await query.edit_message_text("GitHub 构建触发失败，请联系管理员。")
                return
        else:
            endpoint = f"https://api.github.com/repos/{self.settings.github_repo}/actions/workflows/{workflow}/dispatches"
            headers = {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.settings.github_token}",
                "X-GitHub-Api-Version": "2022-11-28",
            }
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    endpoint,
                    headers=headers,
                    json={"ref": self.settings.github_ref, "inputs": inputs},
                )
            if response.status_code != 204:
                logging.error("GitHub dispatch failed: %s %s", response.status_code, response.text)
                await query.edit_message_text("GitHub 构建触发失败，请联系管理员。")
                return
        serialized_inputs = json.dumps(inputs, sort_keys=True)
        self.db.record_build(user_id, serial, workflow, serialized_inputs)
        self.db.create_build_job(
            request_id, user_id, delivery_chat_id, workflow, serialized_inputs
        )
        context.user_data.clear()
        await query.edit_message_text("构建已提交，请等待完成。完成后机器人会直接发送刷机包。")

    def github_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.settings.github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def post_init(self, application: Application) -> None:
        public_commands = [
            BotCommand("start", "验证序列号"),
            BotCommand("join", "验证序列号并申请入群"),
        ]
        owner_commands = [
            BotCommand("start", "启动机器人"),
            BotCommand("build", "构建绑定设备的内核"),
            BotCommand("buildfor", "为指定白名单序列号构建"),
            BotCommand("allow", "添加白名单序列号"),
            BotCommand("revoke", "撤销白名单序列号"),
            BotCommand("allowed", "查看完整白名单"),
            BotCommand("joinlink", "获取入频道验证链接"),
        ]
        await application.bot.set_my_commands(public_commands)
        for admin_user_id in self.settings.admin_user_ids:
            await application.bot.set_my_commands(
                owner_commands,
                scope=BotCommandScopeChat(chat_id=admin_user_id),
            )
        self._monitor_task = asyncio.create_task(self.monitor_builds(application))

    async def post_shutdown(self, application: Application) -> None:
        if self._monitor_task:
            self._monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._monitor_task

    async def monitor_builds(self, application: Application) -> None:
        while True:
            for job in self.db.pending_build_jobs():
                try:
                    await self.process_build_job(application, job)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logging.exception("build monitor failed for request %s", job["request_id"])
            await asyncio.sleep(15)

    async def process_build_job(self, application: Application, job) -> None:
        request_id = job["request_id"]
        run_id = job["github_run_id"]
        api_root = f"https://api.github.com/repos/{self.settings.github_repo}"
        timeout = httpx.Timeout(120, connect=30)
        async with httpx.AsyncClient(
            headers=self.github_headers(), timeout=timeout, follow_redirects=True
        ) as client:
            if run_id is None:
                response = await client.get(
                    f"{api_root}/actions/workflows/{job['workflow_file']}/runs",
                    params={"event": "workflow_dispatch", "per_page": 50},
                )
                response.raise_for_status()
                workflow_runs = response.json().get("workflow_runs", [])
                run = next(
                    (
                        item
                        for item in workflow_runs
                        if request_id in (item.get("display_title") or "")
                    ),
                    None,
                )
                # User-facing run names contain the kernel version and bound
                # serial. Keep the opaque correlation id in the build job name
                # and inspect only newly-created candidate runs when needed.
                if run is None:
                    created_after = int(job["created_at"]) - 120
                    for candidate in workflow_runs:
                        created_text = candidate.get("created_at") or ""
                        try:
                            created_ts = int(
                                datetime.fromisoformat(
                                    created_text.replace("Z", "+00:00")
                                ).timestamp()
                            )
                        except ValueError:
                            continue
                        if created_ts < created_after:
                            continue
                        jobs_response = await client.get(
                            f"{api_root}/actions/runs/{candidate['id']}/jobs",
                            params={"per_page": 10},
                        )
                        jobs_response.raise_for_status()
                        if any(
                            request_id in (run_job.get("name") or "")
                            for run_job in jobs_response.json().get("jobs", [])
                        ):
                            run = candidate
                            break
                if run is None:
                    if int(time.time()) - int(job["created_at"]) > 900:
                        await application.bot.send_message(
                            job["chat_id"], "未能关联本次构建，请联系管理员。"
                        )
                        self.db.update_build_job(request_id, "failed")
                    return
                run_id = int(run["id"])
                self.db.update_build_job(request_id, "running", run_id)
            else:
                response = await client.get(f"{api_root}/actions/runs/{run_id}")
                response.raise_for_status()
                run = response.json()

            if run.get("status") != "completed":
                self.db.update_build_job(request_id, "running", run_id)
                return
            if run.get("conclusion") != "success":
                await application.bot.send_message(job["chat_id"], "本次构建失败，请联系管理员。")
                self.db.update_build_job(request_id, "failed", run_id)
                return

            self.db.update_build_job(request_id, "delivery_pending", run_id)
            response = await client.get(f"{api_root}/actions/runs/{run_id}/artifacts")
            response.raise_for_status()
            artifacts = response.json().get("artifacts", [])
            try:
                build_inputs = json.loads(job["inputs"] or "{}")
            except (json.JSONDecodeError, TypeError):
                build_inputs = {}
            nomount_requested = str(build_inputs.get("nomount_enable", "false")).lower() == "true"

            packages = [
                (
                    "AK3",
                    re.compile(r"^(AnyKernel3|ak3)_.*\.zip$", re.I),
                    "构建完成，刷机前请确认机型和序列号。",
                    True,
                )
            ]
            if nomount_requested:
                packages.append(
                    (
                        "NoMount",
                        re.compile(r"^NoMount(?:-Suite)?(?:[-_].*)?(?:\.zip)?$", re.I),
                        "NoMount 模块已随本次构建生成，请在对应内核上安装。",
                        False,
                    )
                )

            selected_packages = []
            for package_type, filename_pattern, caption, extract_nested in packages:
                artifact = next(
                    (
                        item
                        for item in artifacts
                        if filename_pattern.match(item.get("name", ""))
                        and not item.get("expired")
                    ),
                    None,
                )
                if artifact is None:
                    logging.warning(
                        "%s artifact is not available yet for run %s",
                        package_type,
                        run_id,
                    )
                    return
                selected_packages.append((artifact, filename_pattern, caption, extract_nested))

            with tempfile.TemporaryDirectory(prefix="oneplus-gki-") as temp_dir:
                temp = Path(temp_dir)
                for index, (artifact, filename_pattern, caption, extract_nested) in enumerate(
                    selected_packages
                ):
                    archive_path = temp / f"artifact-download-{index}.zip"
                    async with client.stream("GET", artifact["archive_download_url"]) as download:
                        download.raise_for_status()
                        with archive_path.open("wb") as output:
                            async for chunk in download.aiter_bytes():
                                output.write(chunk)

                    send_path = archive_path
                    send_name = artifact["name"]
                    if not send_name.lower().endswith(".zip"):
                        send_name += ".zip"
                    if extract_nested:
                        with zipfile.ZipFile(archive_path) as archive:
                            nested = [
                                info
                                for info in archive.infolist()
                                if not info.is_dir()
                                and filename_pattern.match(Path(info.filename).name)
                            ]
                            if len(nested) == 1:
                                send_name = Path(nested[0].filename).name
                                send_path = temp / f"{index}-{send_name}"
                                with archive.open(nested[0]) as source, send_path.open("wb") as output:
                                    shutil.copyfileobj(source, output)

                    with send_path.open("rb") as document:
                        await application.bot.send_document(
                            chat_id=job["chat_id"],
                            document=document,
                            filename=send_name,
                            # Regular recipients receive files without build details.
                            caption=caption if self.is_admin(job["chat_id"]) else None,
                            read_timeout=120,
                            write_timeout=120,
                            connect_timeout=30,
                            pool_timeout=30,
                        )
            self.db.update_build_job(request_id, "sent", run_id)

    async def allow(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if not self.is_admin(update.effective_user.id):
            await update.effective_message.reply_text("无权使用管理员命令。")
            return
        if not context.args or not SERIAL_RE.fullmatch(context.args[0]):
            await update.effective_message.reply_text("用法：/allow 序列号")
            return
        self.db.allow_serial(context.args[0], None, update.effective_user.id)
        await update.effective_message.reply_text(f"已允许尾号 {context.args[0][-4:]}。")

    async def revoke(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if not self.is_admin(update.effective_user.id):
            await update.effective_message.reply_text("无权使用管理员命令。")
            return
        if not context.args or not SERIAL_RE.fullmatch(context.args[0]):
            await update.effective_message.reply_text("用法：/revoke 序列号")
            return
        changed = self.db.revoke_serial(context.args[0])
        await update.effective_message.reply_text("已撤销。" if changed else "数据库中没有该序列号。")

    async def allowed(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if not self.is_admin(update.effective_user.id):
            await update.effective_message.reply_text("无权使用管理员命令。")
            return
        rows = self.db.list_serials()
        lines = [
            f"{row['serial_value'] or '…' + row['serial_tail']} | 用户 {row['owner_user_id'] or '不限'} | "
            f"{'启用' if row['enabled'] else '停用'}"
            for row in rows
        ]
        if not lines:
            await update.effective_message.reply_text("数据库为空。")
            return
        chunk = "白名单序列号："
        for line in lines:
            if len(chunk) + len(line) + 1 > 3900:
                await update.effective_message.reply_text(chunk)
                chunk = "白名单序列号（续）："
            chunk += "\n" + line
        await update.effective_message.reply_text(chunk)

    async def join_link(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if not self.is_admin(update.effective_user.id):
            await update.effective_message.reply_text("无权使用管理员命令。")
            return
        invite = await context.bot.create_chat_invite_link(
            chat_id=self.settings.required_channel_id,
            name=f"serial-approval-{datetime.now(timezone.utc):%Y%m%d}",
            creates_join_request=True,
        )
        await update.effective_message.reply_text(
            "这是需要机器人审核的频道申请链接，用户不能直接进入：\n" + invite.invite_link
        )

    async def whitelist_document(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        if not self.is_admin(update.effective_user.id):
            await update.effective_message.reply_text("无权导入白名单。")
            return
        document = update.effective_message.document
        name = (document.file_name or "").lower()
        if not name.endswith((".txt", ".csv")):
            await update.effective_message.reply_text("仅支持 UTF-8 编码的 .txt 或 .csv 白名单文件。")
            return
        if document.file_size and document.file_size > 1024 * 1024:
            await update.effective_message.reply_text("白名单文件不能超过 1 MiB。")
            return
        telegram_file = await document.get_file()
        payload = await telegram_file.download_as_bytearray()
        try:
            text = bytes(payload).decode("utf-8-sig")
        except UnicodeDecodeError:
            await update.effective_message.reply_text("文件不是有效的 UTF-8 文本。")
            return
        rows, errors = parse_whitelist(text)
        if len(rows) > 5000:
            await update.effective_message.reply_text("单次最多导入 5000 条序列号。")
            return
        for serial, owner in rows:
            self.db.allow_serial(serial, owner, update.effective_user.id)
        summary = f"已导入 {len(rows)} 条白名单序列号。"
        if errors:
            summary += f"\n跳过 {len(errors)} 行：\n" + "\n".join(errors[:20])
            if len(errors) > 20:
                summary += f"\n……另有 {len(errors) - 20} 行"
        await update.effective_message.reply_text(summary)

    async def unknown_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.reject_while_building(update):
            return
        await update.effective_message.reply_text("未知命令。请使用 /start。")

    def application(self) -> Application:
        app = (
            Application.builder()
            .token(self.settings.telegram_token)
            .post_init(self.post_init)
            .post_shutdown(self.post_shutdown)
            .build()
        )
        app.add_handler(CommandHandler("start", self.start))
        app.add_handler(CommandHandler("join", self.join))
        app.add_handler(CommandHandler("build", self.build))
        app.add_handler(CommandHandler("buildfor", self.build_for))
        app.add_handler(CommandHandler("allow", self.allow))
        app.add_handler(CommandHandler("revoke", self.revoke))
        app.add_handler(CommandHandler("allowed", self.allowed))
        app.add_handler(CommandHandler("joinlink", self.join_link))
        app.add_handler(MessageHandler(filters.COMMAND, self.unknown_command))
        app.add_handler(ChatJoinRequestHandler(self.join_request))
        app.add_handler(CallbackQueryHandler(self.callback))
        app.add_handler(MessageHandler(filters.Document.ALL, self.whitelist_document))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.text_message))
        return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    # httpx logs the full Bot API URL, which contains the Telegram token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    KernelBuildBot(Settings.from_env()).application().run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
