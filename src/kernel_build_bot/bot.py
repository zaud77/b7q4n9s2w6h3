from __future__ import annotations

import json
import logging
import re

import httpx
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatMemberStatus
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

from .config import Settings
from .db import Database

SERIAL_RE = re.compile(r"^[A-Za-z0-9._:-]{6,64}$")

WORKFLOWS = {
    "623": ("6.12.23 · OnePlus 15", "build.yml"),
    "638a": ("6.12.38 · Ace6T", "fastbuild_6.12.38.yml"),
    "638t": ("6.12.38 · OnePlus 15T", "fastbuild_6.12.38_oneplus_15t.yml"),
    "658": ("6.12.58", "fastbuild_6.12.58.yml"),
}

BOOL_LABELS = {
    "self_config": "自用配置",
    "susfs_enable": "SUSFS",
    "nomount_enable": "NoMount / PathMask / AppCloak",
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


def defaults() -> dict[str, str]:
    values = {key: "false" for key in BOOL_LABELS}
    values.update(
        ksu_type="resukisu",
        lz4_enable="true",
        unicode_enable="true",
        bbr_enable="false",
        droidspaces_enable="false",
        ccache_update="true",
        ccache_debug="false",
    )
    return values


class KernelBuildBot:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = Database(settings.database_path, settings.serial_pepper)

    def is_admin(self, user_id: int) -> bool:
        return user_id in self.settings.admin_user_ids

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

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await update.effective_message.reply_text(
            "使用 /build 发起内核构建。构建前会同时检查频道成员身份和序列号白名单。"
        )

    async def build(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user = update.effective_user
        if not await self.is_channel_member(context, user.id):
            suffix = f"\n加入频道：{self.settings.required_channel_url}" if self.settings.required_channel_url else ""
            await update.effective_message.reply_text("未通过频道成员验证。" + suffix)
            return
        context.user_data.clear()
        context.user_data["awaiting_serial"] = True
        await update.effective_message.reply_text("请输入需要绑定的设备序列号：")

    async def serial_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not context.user_data.get("awaiting_serial"):
            return
        serial = update.effective_message.text.strip()
        if not SERIAL_RE.fullmatch(serial):
            await update.effective_message.reply_text("序列号格式无效，请重新输入。")
            return
        user_id = update.effective_user.id
        if not await self.is_channel_member(context, user_id) or not self.db.verify_serial(serial, user_id):
            context.user_data.clear()
            await update.effective_message.reply_text("频道或序列号数据库验证失败。")
            return
        context.user_data.update(awaiting_serial=False, serial=serial, options=defaults())
        keyboard = [[InlineKeyboardButton(label, callback_data=f"kernel:{key}")] for key, (label, _) in WORKFLOWS.items()]
        keyboard.append([InlineKeyboardButton("取消", callback_data="cancel")])
        await update.effective_message.reply_text("请选择内核版本/机型：", reply_markup=InlineKeyboardMarkup(keyboard))

    def options_markup(self, options: dict[str, str]) -> InlineKeyboardMarkup:
        rows = []
        for key, label in BOOL_LABELS.items():
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
        await query.answer()
        data = query.data
        if data == "cancel":
            context.user_data.clear()
            await query.edit_message_text("已取消。")
            return
        if data.startswith("kernel:"):
            key = data.split(":", 1)[1]
            if key not in WORKFLOWS or "serial" not in context.user_data:
                await query.edit_message_text("会话已失效，请重新使用 /build。")
                return
            context.user_data["workflow"] = key
            await query.edit_message_text(
                f"已选择：{WORKFLOWS[key][0]}\n继续选择功能：",
                reply_markup=self.options_markup(context.user_data["options"]),
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
        await query.edit_message_reply_markup(reply_markup=self.options_markup(options))

    async def dispatch(self, query, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id = query.from_user.id
        serial = context.user_data.get("serial", "")
        workflow_key = context.user_data.get("workflow", "")
        if not await self.is_channel_member(context, user_id) or not self.db.verify_serial(serial, user_id):
            context.user_data.clear()
            await query.edit_message_text("最终授权检查失败，未触发构建。")
            return
        wait = self.db.seconds_until_allowed(user_id, self.settings.cooldown_seconds)
        if wait:
            await query.answer(f"请在 {wait} 秒后再构建", show_alert=True)
            return
        if workflow_key not in WORKFLOWS:
            await query.edit_message_text("未选择有效工作流。")
            return
        _, workflow = WORKFLOWS[workflow_key]
        inputs = dict(context.user_data["options"])
        inputs["device_serial"] = serial
        endpoint = f"https://api.github.com/repos/{self.settings.github_repo}/actions/workflows/{workflow}/dispatches"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.settings.github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(endpoint, headers=headers, json={"ref": self.settings.github_ref, "inputs": inputs})
        if response.status_code != 204:
            logging.error("GitHub dispatch failed: %s %s", response.status_code, response.text)
            await query.edit_message_text("GitHub 构建触发失败，请联系管理员。")
            return
        self.db.record_build(user_id, serial, workflow, json.dumps(inputs, sort_keys=True))
        actions_url = f"https://github.com/{self.settings.github_repo}/actions/workflows/{workflow}"
        context.user_data.clear()
        await query.edit_message_text(f"授权通过，构建已提交：\n{actions_url}")

    async def allow(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.is_admin(update.effective_user.id):
            return
        if not context.args or not SERIAL_RE.fullmatch(context.args[0]):
            await update.effective_message.reply_text("用法：/allow 序列号 [绑定的Telegram用户ID]")
            return
        owner = int(context.args[1]) if len(context.args) > 1 else None
        self.db.allow_serial(context.args[0], owner, update.effective_user.id)
        await update.effective_message.reply_text(f"已允许尾号 {context.args[0][-4:]}。")

    async def revoke(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.is_admin(update.effective_user.id):
            return
        if not context.args or not SERIAL_RE.fullmatch(context.args[0]):
            await update.effective_message.reply_text("用法：/revoke 序列号")
            return
        changed = self.db.revoke_serial(context.args[0])
        await update.effective_message.reply_text("已撤销。" if changed else "数据库中没有该序列号。")

    async def allowed(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.is_admin(update.effective_user.id):
            return
        rows = self.db.list_serials()
        text = "\n".join(
            f"…{row['serial_tail']} | 用户 {row['owner_user_id'] or '不限'} | {'启用' if row['enabled'] else '停用'}"
            for row in rows[:100]
        ) or "数据库为空。"
        await update.effective_message.reply_text(text)

    def application(self) -> Application:
        app = Application.builder().token(self.settings.telegram_token).build()
        app.add_handler(CommandHandler("start", self.start))
        app.add_handler(CommandHandler("build", self.build))
        app.add_handler(CommandHandler("allow", self.allow))
        app.add_handler(CommandHandler("revoke", self.revoke))
        app.add_handler(CommandHandler("allowed", self.allowed))
        app.add_handler(CallbackQueryHandler(self.callback))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.serial_message))
        return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    KernelBuildBot(Settings.from_env()).application().run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()

