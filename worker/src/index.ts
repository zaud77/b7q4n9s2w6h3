import { unzipSync } from "fflate";

type Env = {
  SERIALS: KVNamespace;
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  SERIAL_PEPPER: string;
  WEBHOOK_SECRET: string;
  REQUIRED_CHANNEL_ID: string;
  REQUIRED_CHANNEL_URL: string;
  ADMIN_USER_IDS: string;
  GITHUB_REPO: string;
  GITHUB_REF: string;
  BUILD_COOLDOWN_SECONDS: string;
  DAILY_BUILD_LIMIT: string;
  DAILY_BUILD_BONUS_DATE?: string;
  DAILY_BUILD_BONUS?: string;
};

type Session = {
  awaitingJoinSerial?: boolean;
  serial?: string;
  workflow?: string;
  selectedScript?: string;
  options?: Record<string, string>;
  ownerDirectedBuild?: boolean;
  deliveryChatId?: number;
};

const SERIAL_RE = /^[A-Za-z0-9._:-]{6,64}$/;
const DATA_MIGRATION_KEY = "migration:explicit-workflow-binding-v2";
const SCRIPTS: Record<string, [string, Record<string, [string, string]> | null]> = {
  "623": ["6.12.23 · OnePlus 15", {
    gold: ["金标", "623g"],
    purple: ["紫标", "623p"],
  }],
  "638t": ["6.12.38 · OnePlus 15T", {
    gold: ["金标", "638tg"],
    purple: ["紫标", "638tp"],
  }],
  "623m": ["6.12.23 · OPPO Find X9", {
    purple: ["紫标", "623mp"],
  }],
  "638a": ["6.12.38 · OnePlus Ace 6T", {
    gold: ["金标", "638ag"],
    purple: ["紫标", "638ap"],
  }],
  "658": ["6.12.58 · OnePlus Pad 3 Pro", {
    purple: ["紫标", "658p"],
  }],
  "658m": ["6.12.58 · OnePlus Ace 6 Ultra", {
    gold: ["金标", "658mg"],
    purple: ["紫标", "658mp"],
  }],
};
const WORKFLOWS: Record<string, [string, string]> = {
  "623g": ["6.12.23 · OnePlus 15 · 金标", "fastbuild_6.12.23_oneplus_15_hmbird_gold.yml"],
  "623p": ["6.12.23 · OnePlus 15 · 紫标", "fastbuild_6.12.23_oneplus_15_hmbird_purple.yml"],
  "638tg": ["6.12.38 · OnePlus 15T · 金标", "fastbuild_6.12.38_oneplus_15t_hmbird_gold.yml"],
  "638tp": ["6.12.38 · OnePlus 15T · 紫标", "fastbuild_6.12.38_oneplus_15t_hmbird_purple.yml"],
  "638ag": ["6.12.38 · OnePlus Ace 6T · 金标", "fastbuild_6.12.38_oneplus_ace6t_hmbird_gold.yml"],
  "638ap": ["6.12.38 · OnePlus Ace 6T · 紫标", "fastbuild_6.12.38_oneplus_ace6t_hmbird_purple.yml"],
  "658p": ["6.12.58 · OnePlus Pad 3 Pro · 紫标", "fastbuild_6.12.58_hmbird_purple.yml"],
  "623mp": ["6.12.23 · OPPO Find X9 · 紫标", "fastbuild_6.12.23_mtk_hmbird_purple.yml"],
  "658mg": ["6.12.58 · OnePlus Ace 6 Ultra · 金标", "fastbuild_6.12.58_mtk_hmbird_gold.yml"],
  "658mp": ["6.12.58 · OnePlus Ace 6 Ultra · 紫标", "fastbuild_6.12.58_mtk_hmbird_purple.yml"],
};
const WORKFLOW_SCRIPTS: Record<string, string> = Object.fromEntries(
  Object.entries(SCRIPTS).flatMap(([scriptKey, value]) =>
    value[1] ? Object.values(value[1]).map(([, workflowKey]) => [workflowKey, scriptKey]) : [[scriptKey, scriptKey]]
  )
);
const ONEPLUS_15_WORKFLOW_KEYS = new Set(["623g", "623p"]);
const ONEPLUS_15T_WORKFLOW_KEYS = new Set(["638tg", "638tp"]);
const LEGACY_WORKFLOW_KEYS: Record<string, string> = {
  ...WORKFLOW_SCRIPTS,
  // Preserve old device bindings after variants without an official matching
  // HMBIRD commit were removed from the selectable workflow list.
  "623mg": "623m",
  "658g": "658",
};
const BOOL_LABELS: Record<string, string> = {
  self_config: "自用配置",
  susfs_enable: "SUSFS",
  nomount_enable: "NoMount",
  kpm_enable: "KPM / KPatch Next",
  lz4_enable: "LZ4 + Zstd",
  lz4kd_enable: "LZ4KD",
  zarm_tool: "zarm 工具",
  unicode_enable: "Unicode 修复",
  better_net: "网络增强",
  adios_enable: "ADIOS",
  rekernel_enable: "Re-Kernel",
  baseband_guard: "基带保护",
};
const KSU_VALUES = ["resukisu", "sukisu", "ksunext", "ksu", "none"];
const BBR_VALUES = ["false", "true", "default"];
const DROID_VALUES = ["false", "standard", "extend"];

function now(): number { return Math.floor(Date.now() / 1000); }
function admins(env: Env): Set<number> {
  return new Set(env.ADMIN_USER_IDS.split(",").map(v => Number(v.trim())).filter(Boolean));
}
function isAdmin(env: Env, userId: number): boolean { return admins(env).has(userId); }
function defaults(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of Object.keys(BOOL_LABELS)) values[key] = "false";
  return Object.assign(values, {
    ksu_type: "resukisu", lz4_enable: "true", unicode_enable: "true",
    bbr_enable: "false", droidspaces_enable: "false",
    ccache_update: "false", ccache_debug: "false",
  });
}
function applyWorkflowDefaults(workflowKey: string, options: Record<string, string>): Record<string, string> {
  if (ONEPLUS_15T_WORKFLOW_KEYS.has(workflowKey)) {
    options.lz4_enable = "false";
    options.unicode_enable = "false";
  }
  return options;
}
function supportsSelfConfig(workflowKey: string): boolean {
  return ONEPLUS_15_WORKFLOW_KEYS.has(workflowKey);
}
function normalizeWorkflowKey(workflowKey: string | null | undefined): string | null {
  if (!workflowKey) return null;
  return LEGACY_WORKFLOW_KEYS[workflowKey] || workflowKey;
}

async function digestSerial(env: Env, serial: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SERIAL_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(serial));
  return [...new Uint8Array(sig)].map(v => v.toString(16).padStart(2, "0")).join("");
}

async function tg(env: Env, method: string, body: unknown): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result: any = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${response.status} ${result.description || "failed"}`);
  return result.result;
}

async function sendMessage(env: Env, chatId: number | string, text: string, replyMarkup?: unknown) {
  return tg(env, "sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
async function editMessage(env: Env, chatId: number | string, messageId: number, text: string, replyMarkup?: unknown) {
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}
async function answerCallback(env: Env, id: string, text?: string, showAlert = false) {
  return tg(env, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: showAlert } : {}) });
}

async function setUserCommands(env: Env, userId: number, bound: boolean): Promise<boolean> {
  const commands = isAdmin(env, userId)
    ? [
      { command: "start", description: "启动机器人" },
      { command: "build", description: "构建绑定设备的内核" },
      { command: "buildfor", description: "为指定白名单序列号构建" },
      { command: "allow", description: "添加白名单序列号" },
      { command: "revoke", description: "撤销白名单序列号" },
      { command: "allowed", description: "查看完整白名单" },
      { command: "joinlink", description: "获取入群验证链接" },
    ]
    : bound
      ? [
        { command: "start", description: "启动机器人" },
        { command: "build", description: "构建绑定设备的内核" },
      ]
      : [
        { command: "start", description: "验证序列号" },
        { command: "join", description: "验证序列号并申请入群" },
      ];
  try {
    await tg(env, "setMyCommands", { commands, scope: { type: "chat", chat_id: userId } });
    return true;
  } catch (error) {
    console.error("set user commands failed", userId, String(error));
    return false;
  }
}

async function getSession(env: Env, userId: number): Promise<Session> {
  const row: any = await env.DB.prepare("SELECT data FROM sessions WHERE telegram_user_id=?").bind(userId).first();
  if (!row) return {};
  try { return JSON.parse(row.data); } catch { return {}; }
}
async function setSession(env: Env, userId: number, data: Session) {
  await env.DB.prepare(
    "INSERT INTO sessions(telegram_user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at"
  ).bind(userId, JSON.stringify(data), now()).run();
}
async function clearSession(env: Env, userId: number) {
  await env.DB.prepare("DELETE FROM sessions WHERE telegram_user_id=?").bind(userId).run();
}
async function activeBuild(env: Env, userId: number): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 AS yes FROM build_jobs WHERE active_user_id=? LIMIT 1").bind(userId).first());
}
async function isMember(env: Env, userId: number): Promise<boolean> {
  try {
    const member = await tg(env, "getChatMember", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: userId });
    return ["member", "administrator", "creator"].includes(member.status);
  } catch { return false; }
}

async function createJoinRequestInvite(env: Env, userId: number): Promise<string> {
  const invite = await tg(env, "createChatInviteLink", {
    chat_id: env.REQUIRED_CHANNEL_ID,
    name: `verified-${userId}-${now()}`,
    creates_join_request: true,
  });
  return invite.invite_link;
}

async function recoverJoinApproval(
  env: Env,
  userId: number,
  messageChatId: number | string,
  error: unknown
): Promise<void> {
  console.error("approve join request failed", userId, String(error));
  if (await isMember(env, userId)) {
    await env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(userId).run();
    await clearSession(env, userId);
    await sendMessage(env, messageChatId, "你已经是频道成员，序列号已绑定，可直接使用 /build。");
    return;
  }
  try {
    const inviteLink = await createJoinRequestInvite(env, userId);
    await sendMessage(
      env,
      messageChatId,
      `原加入申请已失效。请使用以下链接重新提交加入申请，机器人会自动批准：\n${inviteLink}`
    );
  } catch (inviteError) {
    console.error("create recovery join invite failed", userId, String(inviteError));
    await sendMessage(
      env,
      messageChatId,
      "序列号已通过，但批准入群失败，请联系管理员。"
    );
  }
}

async function serialRecord(env: Env, serial: string): Promise<any | null> {
  const hash = await digestSerial(env, serial);
  const kv = await env.SERIALS.get(`serial:${hash}`, "json") as any;
  if (!kv?.enabled) return null;
  return { ...kv, hash };
}
async function serialForUser(env: Env, userId: number): Promise<string | null> {
  const row: any = await env.DB.prepare(
    "SELECT serial_value FROM serial_bindings WHERE owner_user_id=? AND enabled=1 ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
  return row?.serial_value || null;
}
async function claimSerial(env: Env, serial: string, userId: number): Promise<boolean> {
  const record = await serialRecord(env, serial);
  if (!record) return false;
  const row: any = await env.DB.prepare("SELECT owner_user_id FROM serial_bindings WHERE serial_hash=?").bind(record.hash).first();
  if (row?.owner_user_id != null && Number(row.owner_user_id) !== userId) return false;
  await env.DB.prepare(
    "INSERT INTO serial_bindings(serial_hash,serial_value,owner_user_id,enabled,created_at,created_by) VALUES(?,?,?,1,?,0) " +
    "ON CONFLICT(serial_hash) DO UPDATE SET owner_user_id=COALESCE(serial_bindings.owner_user_id,excluded.owner_user_id),serial_value=excluded.serial_value,enabled=1"
  ).bind(record.hash, serial, userId, now()).run();
  return true;
}

async function allowSerial(env: Env, serial: string, createdBy: number) {
  const hash = await digestSerial(env, serial);
  await env.SERIALS.put(`serial:${hash}`, JSON.stringify({ serial, enabled: true }));
  const index = (await env.SERIALS.get("serial:index", "json") as string[] | null) || [];
  if (!index.includes(hash)) { index.push(hash); await env.SERIALS.put("serial:index", JSON.stringify(index)); }
  await env.DB.prepare(
    "INSERT INTO serial_bindings(serial_hash,serial_value,owner_user_id,enabled,created_at,created_by) VALUES(?,?,NULL,1,?,?) " +
    "ON CONFLICT(serial_hash) DO UPDATE SET serial_value=excluded.serial_value,enabled=1"
  ).bind(hash, serial, now(), createdBy).run();
}
async function removeRevokedUserAccess(env: Env, userId: number): Promise<boolean> {
  await clearSession(env, userId);
  const commandsReset = await setUserCommands(env, userId, false);
  if (isAdmin(env, userId)) return commandsReset;
  try {
    await tg(env, "banChatMember", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: userId });
    await tg(env, "unbanChatMember", {
      chat_id: env.REQUIRED_CHANNEL_ID,
      user_id: userId,
      only_if_banned: true,
    });
    return commandsReset;
  } catch (error) {
    console.error("remove revoked user from group failed", userId, String(error));
    return false;
  }
}

type RevokeResult = { removed: boolean; ownerUserId?: number; accessReset?: boolean };

async function revokeSerial(env: Env, serial: string): Promise<RevokeResult> {
  const hash = await digestSerial(env, serial);
  const record: any = await env.SERIALS.get(`serial:${hash}`, "json");
  const row: any = await env.DB.prepare("SELECT owner_user_id FROM serial_bindings WHERE serial_hash=?").bind(hash).first();
  if (!record && !row) return { removed: false };
  await env.SERIALS.delete(`serial:${hash}`);
  const index = (await env.SERIALS.get("serial:index", "json") as string[] | null) || [];
  if (index.includes(hash)) await env.SERIALS.put("serial:index", JSON.stringify(index.filter(value => value !== hash)));
  const statements = [env.DB.prepare("DELETE FROM serial_bindings WHERE serial_hash=?").bind(hash)];
  if (row?.owner_user_id != null) {
    statements.push(env.DB.prepare("DELETE FROM workflow_bindings WHERE telegram_user_id=?").bind(row.owner_user_id));
    statements.push(env.DB.prepare("DELETE FROM sessions WHERE telegram_user_id=?").bind(row.owner_user_id));
    statements.push(env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(row.owner_user_id));
  }
  await env.DB.batch(statements);
  if (row?.owner_user_id == null) return { removed: true };
  const ownerUserId = Number(row.owner_user_id);
  return { removed: true, ownerUserId, accessReset: await removeRevokedUserAccess(env, ownerUserId) };
}

async function applyDataMigrations(env: Env): Promise<string> {
  const marker: any = await env.DB.prepare("SELECT value FROM bot_state WHERE key=?").bind(DATA_MIGRATION_KEY).first();
  if (marker?.value === "done") return DATA_MIGRATION_KEY;

  let pendingUserIds: number[] = [];
  if (marker?.value) {
    try {
      const state = JSON.parse(marker.value);
      pendingUserIds = Array.isArray(state.pendingUserIds)
        ? state.pendingUserIds.map(Number).filter(Number.isFinite)
        : [];
    } catch {
      pendingUserIds = [];
    }
  } else {
    const disabled: any = await env.DB.prepare(
      "SELECT serial_hash,owner_user_id FROM serial_bindings WHERE enabled=0"
    ).all();
    const disabledRows: any[] = disabled.results || [];
    const disabledHashes = new Set(disabledRows.map(row => String(row.serial_hash)));
    for (const hash of disabledHashes) await env.SERIALS.delete(`serial:${hash}`);
    const index = (await env.SERIALS.get("serial:index", "json") as string[] | null) || [];
    await env.SERIALS.put("serial:index", JSON.stringify(index.filter(hash => !disabledHashes.has(hash))));
    pendingUserIds = [...new Set(
      disabledRows
        .filter(row => row.owner_user_id != null)
        .map(row => Number(row.owner_user_id))
        .filter(Number.isFinite)
    )];
    const value = pendingUserIds.length ? JSON.stringify({ pendingUserIds }) : "done";
    await env.DB.batch([
      env.DB.prepare("DELETE FROM workflow_bindings"),
      env.DB.prepare("DELETE FROM sessions"),
      env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id IN (SELECT owner_user_id FROM serial_bindings WHERE enabled=0)"),
      env.DB.prepare("DELETE FROM serial_bindings WHERE enabled=0"),
      env.DB.prepare(
        "INSERT INTO bot_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(DATA_MIGRATION_KEY, value),
    ]);
  }

  if (!pendingUserIds.length) return DATA_MIGRATION_KEY;
  const remaining: number[] = [];
  for (const userId of pendingUserIds) {
    if (!(await removeRevokedUserAccess(env, userId))) remaining.push(userId);
  }
  const value = remaining.length ? JSON.stringify({ pendingUserIds: remaining }) : "done";
  await env.DB.prepare("UPDATE bot_state SET value=? WHERE key=?").bind(value, DATA_MIGRATION_KEY).run();
  return remaining.length ? `${DATA_MIGRATION_KEY}:telegram-cleanup-pending` : DATA_MIGRATION_KEY;
}

function optionsMarkup(options: Record<string, string>, showSelf: boolean) {
  const rows: any[] = [];
  for (const [key, label] of Object.entries(BOOL_LABELS)) {
    if (key === "self_config" && !showSelf) continue;
    rows.push([{ text: `${options[key] === "true" ? "✅" : "⬜"} ${label}`, callback_data: `toggle:${key}` }]);
  }
  rows.push([{ text: `KernelSU：${options.ksu_type}`, callback_data: "cycle:ksu_type" }]);
  rows.push([{ text: `BBR/Brutal：${options.bbr_enable}`, callback_data: "cycle:bbr_enable" }]);
  rows.push([{ text: `Droidspaces：${options.droidspaces_enable}`, callback_data: "cycle:droidspaces_enable" }]);
  rows.push([{ text: "⬅️ 上一步", callback_data: "back:variant" }]);
  rows.push([{ text: "开始构建", callback_data: "dispatch" }, { text: "取消", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}
function workflowMarkup() {
  const rows = Object.entries(SCRIPTS).map(([key, value]) => [{ text: value[0], callback_data: `kernel:${key}` }]);
  rows.push([{ text: "取消", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}
function variantMarkup(scriptKey: string, showBack = true, showBind = false) {
  const variants = SCRIPTS[scriptKey][1]!;
  const rows = Object.entries(variants).map(([key, value]) => [{ text: value[0], callback_data: `variant:${scriptKey}:${key}` }]);
  if (showBind) rows.push([{ text: "🔒 绑定此脚本", callback_data: `bind:${scriptKey}` }]);
  if (showBack) rows.push([{ text: "⬅️ 上一步", callback_data: "back:scripts" }]);
  rows.push([{ text: "取消", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

async function workflowForUser(env: Env, userId: number): Promise<string | null> {
  const row: any = await env.DB.prepare("SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=?").bind(userId).first();
  return normalizeWorkflowKey(row?.workflow_key);
}
async function bindWorkflow(env: Env, userId: number, key: string): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO workflow_bindings(telegram_user_id,workflow_key,bound_at) VALUES(?,?,?) " +
    "ON CONFLICT(telegram_user_id) DO NOTHING"
  ).bind(userId, key, now()).run();
  return (await workflowForUser(env, userId))!;
}
async function workflowMaintenance(env: Env, key: string): Promise<boolean> {
  const row: any = await env.DB.prepare("SELECT value FROM bot_state WHERE key=?").bind(`workflow_maintenance:${key}`).first();
  return row?.value === "1";
}

async function rejectWhileBuilding(env: Env, update: any): Promise<boolean> {
  const user = update.callback_query?.from || update.message?.from || update.chat_join_request?.from;
  if (!user || !(await activeBuild(env, user.id))) return false;
  const text = "当前正在构建内核，请等待本次构建完成。";
  if (update.callback_query) await answerCallback(env, update.callback_query.id, text, true);
  else if (update.message) await sendMessage(env, update.message.chat.id, text);
  return true;
}

async function handleCommand(env: Env, update: any, command: string, args: string[]) {
  const message = update.message;
  const userId = message.from.id;
  const chatId = message.chat.id;
  if (await rejectWhileBuilding(env, update)) return;
  const boundSerial = await serialForUser(env, userId);
  if (command !== "start" && command !== "join" && !isAdmin(env, userId) && !boundSerial) {
    await setUserCommands(env, userId, false);
    await sendMessage(env, chatId, "请先使用 /start 绑定设备序列号。");
    return;
  }
  if (command === "start") {
    if (isAdmin(env, userId)) {
      await setUserCommands(env, userId, true);
      await sendMessage(env, chatId, "OnePlus GKI 构建机器人已启动；发送 /build 可选择内核版本和功能。");
      return;
    }
    if (await isMember(env, userId)) {
      if (boundSerial) {
        await clearSession(env, userId);
        await setUserCommands(env, userId, true);
        await sendMessage(env, chatId, "OnePlus GKI 构建机器人已启动；发送 /build 可选择内核版本和功能。");
      } else {
        await setSession(env, userId, { awaitingJoinSerial: true });
        await setUserCommands(env, userId, false);
        await sendMessage(env, chatId, "你已是群组成员。请输入设备序列号完成绑定：");
      }
      return;
    }
    if (boundSerial) {
      await clearSession(env, userId);
      await setUserCommands(env, userId, true);
      const inviteLink = await createJoinRequestInvite(env, userId);
      await sendMessage(env, chatId, `序列号已绑定。请使用以下链接申请进入群组，机器人会自动批准：\n${inviteLink}`);
    } else {
      await setSession(env, userId, { awaitingJoinSerial: true });
      await setUserCommands(env, userId, false);
      await sendMessage(env, chatId, "请输入设备序列号，验证通过后才能进入群组：");
      return;
    }
  }
  if (command === "join") {
    await setSession(env, userId, { awaitingJoinSerial: true });
    await sendMessage(env, chatId, "请输入设备序列号："); return;
  }
  if (command === "build") {
    if (!(await isMember(env, userId))) { await sendMessage(env, chatId, "尚未通过入群验证，请先使用 /start。"); return; }
    const serial = await serialForUser(env, userId);
    if (!serial) { await sendMessage(env, chatId, "当前 Telegram 账号尚未绑定有效序列号，请先使用 /start。"); return; }
    const bound = isAdmin(env, userId) ? null : await workflowForUser(env, userId);
    const options = defaults();
    const session: Session = { serial, options };
    if (bound) {
      if (!SCRIPTS[bound]) { await sendMessage(env, chatId, "已绑定的构建脚本当前不可用，请联系管理员。"); return; }
      const variants = SCRIPTS[bound][1];
      const workflowKeys = variants ? Object.values(variants).map(([, key]) => key) : [bound];
      for (const key of workflowKeys) {
        if (await workflowMaintenance(env, key)) {
          await sendMessage(env, chatId, `${SCRIPTS[bound][0]} 正在建立持久缓存，暂时不能提交构建。`);
          return;
        }
      }
      if (!variants) {
        session.workflow = bound;
        applyWorkflowDefaults(bound, options);
      }
      await setSession(env, userId, session);
      if (variants) await sendMessage(env, chatId, `已绑定：${SCRIPTS[bound][0]}\n请选择风驰版本：`, variantMarkup(bound, isAdmin(env, userId)));
      else await sendMessage(env, chatId, `已绑定：${SCRIPTS[bound][0]}\n请选择功能：`, optionsMarkup(options, isAdmin(env, userId) && supportsSelfConfig(bound)));
      return;
    }
    await setSession(env, userId, session);
    await sendMessage(env, chatId, isAdmin(env, userId) ? "请选择本次构建脚本：" : "首次构建，请选择要绑定的构建脚本：", workflowMarkup());
    return;
  }
  if (command === "buildfor") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "无权使用管理员命令。"); return; }
    const serial = args[0] || "";
    if (!SERIAL_RE.test(serial)) { await sendMessage(env, chatId, "用法：/buildfor 序列号"); return; }
    if (!(await serialRecord(env, serial))) { await sendMessage(env, chatId, "该序列号不在启用的白名单中。"); return; }
    await setSession(env, userId, { serial, options: defaults(), ownerDirectedBuild: true, deliveryChatId: userId });
    await sendMessage(env, chatId, `为序列号 ${serial} 构建；完成后的产物只发送给你。\n请选择构建脚本：`, workflowMarkup()); return;
  }
  if (command === "allow") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "无权使用管理员命令。"); return; }
    const serial = args[0] || "";
    if (!SERIAL_RE.test(serial)) { await sendMessage(env, chatId, "用法：/allow 序列号"); return; }
    await allowSerial(env, serial, userId); await sendMessage(env, chatId, `已允许尾号 ${serial.slice(-4)}。`); return;
  }
  if (command === "revoke") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "无权使用管理员命令。"); return; }
    const serial = args[0] || "";
    if (!SERIAL_RE.test(serial)) { await sendMessage(env, chatId, "用法：/revoke 序列号"); return; }
    const result = await revokeSerial(env, serial);
    if (!result.removed) {
      await sendMessage(env, chatId, "数据库中没有该序列号。");
    } else if (result.ownerUserId == null) {
      await sendMessage(env, chatId, "已从白名单删除。");
    } else if (isAdmin(env, result.ownerUserId)) {
      await sendMessage(env, chatId, "已从白名单删除并清除脚本绑定；管理员账号不会被移出群组。");
    } else if (result.accessReset) {
      await sendMessage(env, chatId, "已从白名单删除，清除脚本绑定和会话，将绑定用户移出群组，并恢复为仅 /start、/join。");
    } else {
      await sendMessage(env, chatId, "白名单、脚本绑定、会话和命令已清理，但移出群组失败；请检查机器人管理员权限。");
    }
    return;
  }
  if (command === "allowed") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "无权使用管理员命令。"); return; }
    const result: any = await env.DB.prepare("SELECT serial_value,owner_user_id,enabled FROM serial_bindings ORDER BY enabled DESC,serial_value").all();
    const lines = result.results.map((r: any) => `${r.serial_value} | 用户 ${r.owner_user_id || "不限"} | ${r.enabled ? "启用" : "停用"}`);
    if (!lines.length) { await sendMessage(env, chatId, "数据库为空。"); return; }
    let chunk = "白名单序列号：";
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 3900) { await sendMessage(env, chatId, chunk); chunk = "白名单序列号（续）："; }
      chunk += `\n${line}`;
    }
    await sendMessage(env, chatId, chunk); return;
  }
  if (command === "joinlink") {
    if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "无权使用管理员命令。"); return; }
    await sendMessage(env, chatId, `这是频道验证入口，用户不能直接进入；打开机器人并按提示验证序列号：\n${env.REQUIRED_CHANNEL_URL}?start=join`); return;
  }
  await sendMessage(env, chatId, "不支持该命令。请使用 /start。");
}

async function handleText(env: Env, update: any) {
  if (await rejectWhileBuilding(env, update)) return;
  const message = update.message; const userId = message.from.id; const serial = String(message.text || "").trim();
  const session = await getSession(env, userId);
  if (!session.awaitingJoinSerial) return;
  if (!SERIAL_RE.test(serial)) { await sendMessage(env, message.chat.id, "序列号格式无效，请重新输入。"); return; }
  const pending: any = await env.DB.prepare("SELECT user_chat_id FROM pending_joins WHERE telegram_user_id=?").bind(userId).first();
  if (!(await claimSerial(env, serial, userId))) {
    if (pending) {
      try { await tg(env, "declineChatJoinRequest", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: userId }); }
      catch (error) { console.error("decline join request failed", userId, String(error)); }
      await env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(userId).run();
    }
    await clearSession(env, userId);
    await setUserCommands(env, userId, false);
    await sendMessage(env, message.chat.id, "序列号验证未通过，已拒绝本次入群申请。请使用 /start 重新验证。");
    return;
  }
  await setUserCommands(env, userId, true);
  if (pending) {
    try {
      await tg(env, "approveChatJoinRequest", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: userId });
      await env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(userId).run();
      await clearSession(env, userId);
      await sendMessage(env, pending.user_chat_id, "序列号验证通过，已批准进入频道。加入后可使用 /build。");
    } catch (error) { await recoverJoinApproval(env, userId, message.chat.id, error); }
    return;
  }
  await clearSession(env, userId);
  if (await isMember(env, userId)) await sendMessage(env, message.chat.id, "序列号已绑定，频道成员身份验证通过，可使用 /build。");
  else {
    const inviteLink = await createJoinRequestInvite(env, userId);
    await sendMessage(env, message.chat.id, `序列号验证通过。请使用以下链接提交频道加入申请，机器人会自动批准：\n${inviteLink}`);
  }
}

async function dispatchBuild(env: Env, query: any, session: Session) {
  const userId = query.from.id; const chatId = query.message.chat.id; const messageId = query.message.message_id;
  if (await activeBuild(env, userId)) { await answerCallback(env, query.id, "当前正在构建内核，请等待本次构建完成。", true); return; }
  const serial = session.serial || ""; const workflowKey = session.workflow || "";
  if (!WORKFLOWS[workflowKey] || !(await serialRecord(env, serial)) || !(await isMember(env, userId))) {
    await clearSession(env, userId); await editMessage(env, chatId, messageId, "最终授权检查失败，未触发构建。"); return;
  }
  const boundScript = WORKFLOW_SCRIPTS[workflowKey] || workflowKey;
  if (!isAdmin(env, userId) && (await workflowForUser(env, userId)) !== boundScript) {
    await editMessage(env, chatId, messageId, "构建脚本绑定复核失败，请重新使用 /build。"); return;
  }
  if (!isAdmin(env, userId)) {
    const latest: any = await env.DB.prepare("SELECT MAX(created_at) AS latest FROM builds WHERE telegram_user_id=?").bind(userId).first();
    const cooldown = Number(env.BUILD_COOLDOWN_SECONDS || 600);
    const wait = latest?.latest ? Math.max(0, cooldown - (now() - Number(latest.latest))) : 0;
    if (wait) { await editMessage(env, chatId, messageId, `请在 ${wait} 秒后再构建。`); return; }
    const beijingNow = now() + 8 * 3600;
    const dayStart = Math.floor(beijingNow / 86400) * 86400 - 8 * 3600;
    const count: any = await env.DB.prepare("SELECT COUNT(*) AS total FROM builds WHERE telegram_user_id=? AND created_at>=?").bind(userId, dayStart).first();
    const beijingDate = new Date(beijingNow * 1000).toISOString().slice(0, 10);
    const dailyBonus = env.DAILY_BUILD_BONUS_DATE === beijingDate ? Number(env.DAILY_BUILD_BONUS || 0) : 0;
    const limit = Number(env.DAILY_BUILD_LIMIT || 2) + Math.max(0, dailyBonus);
    if (Number(count?.total || 0) >= limit) { await editMessage(env, chatId, messageId, `今天已达到 ${limit} 次构建上限，请在北京时间次日再试。`); return; }
  }
  if (await workflowMaintenance(env, workflowKey)) { await editMessage(env, chatId, messageId, `${WORKFLOWS[workflowKey][0]} 正在建立持久缓存，暂时不能提交构建。`); return; }
  const options = { ...(session.options || defaults()) };
  if (!isAdmin(env, userId)) options.self_config = "false";
  if (!supportsSelfConfig(workflowKey)) delete options.self_config;
  const requestId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const inputs = { ...options, device_serial: serial, build_request_id: requestId };
  const workflowFile = WORKFLOWS[workflowKey][1];
  const gh = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: { "accept": "application/vnd.github+json", "authorization": `Bearer ${env.GITHUB_TOKEN}`, "x-github-api-version": "2022-11-28", "user-agent": "oneplus-gki-worker" },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs }),
  });
  if (gh.status !== 204) { console.error("GitHub dispatch", gh.status, await gh.text()); await editMessage(env, chatId, messageId, "GitHub 构建触发失败，请联系管理员。"); return; }
  const serialHash = await digestSerial(env, serial); const created = now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO builds(telegram_user_id,serial_hash,workflow_file,inputs,created_at) VALUES(?,?,?,?,?)").bind(userId, serialHash, workflowFile, JSON.stringify(inputs), created),
      env.DB.prepare("INSERT INTO build_jobs(request_id,telegram_user_id,active_user_id,chat_id,workflow_file,inputs,github_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,'submitted',?,?)")
        .bind(requestId, userId, userId, Number(session.deliveryChatId || userId), workflowFile, JSON.stringify(inputs), created, created),
    ]);
  } catch (e) { console.error("record build", e); await editMessage(env, chatId, messageId, "构建已触发，但状态登记失败，请联系管理员。"); return; }
  await clearSession(env, userId); await editMessage(env, chatId, messageId, "构建已提交，请等待完成。完成后机器人会直接发送刷机包。");
}

async function handleCallback(env: Env, update: any) {
  const query = update.callback_query; const userId = query.from.id; const chatId = query.message.chat.id; const messageId = query.message.message_id;
  if (await rejectWhileBuilding(env, update)) return;
  await answerCallback(env, query.id);
  if (!(await serialForUser(env, userId)) && !isAdmin(env, userId)) {
    await setUserCommands(env, userId, false);
    await editMessage(env, chatId, messageId, "请先使用 /start 绑定设备序列号。");
    return;
  }
  const data = query.data || ""; const session = await getSession(env, userId);
  if (data === "cancel") { await clearSession(env, userId); await editMessage(env, chatId, messageId, "已取消。"); return; }
  if (data === "back:scripts") {
    delete session.workflow; delete session.selectedScript; session.options = defaults();
    if (!isAdmin(env, userId)) {
      const boundScript = await workflowForUser(env, userId);
      if (boundScript && SCRIPTS[boundScript]) {
        await setSession(env, userId, session);
        await editMessage(env, chatId, messageId, `已绑定：${SCRIPTS[boundScript][0]}\n请选择风驰版本：`, variantMarkup(boundScript, false));
        return;
      }
    }
    await setSession(env, userId, session);
    await editMessage(env, chatId, messageId, "请选择本次构建脚本：", workflowMarkup());
    return;
  }
  if (data === "back:variant") {
    const workflowKey = session.workflow || ""; const scriptKey = WORKFLOW_SCRIPTS[workflowKey];
    delete session.workflow;
    if (!scriptKey || !SCRIPTS[scriptKey]) { await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return; }
    await setSession(env, userId, session);
    await editMessage(env, chatId, messageId, `已选择：${SCRIPTS[scriptKey][0]}\n请选择风驰版本：`, variantMarkup(scriptKey, isAdmin(env, userId)));
    return;
  }
  if (data.startsWith("bind:")) {
    const scriptKey = data.slice(5);
    if (isAdmin(env, userId)) { await answerCallback(env, query.id, "所有者无需绑定脚本", true); return; }
    if (!SCRIPTS[scriptKey] || session.selectedScript !== scriptKey || !session.serial) {
      await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return;
    }
    const current = await workflowForUser(env, userId);
    if (current && current !== scriptKey) { await answerCallback(env, query.id, "该账号已绑定其他构建脚本", true); return; }
    const boundScript = await bindWorkflow(env, userId, scriptKey);
    await editMessage(env, chatId, messageId, `已绑定：${SCRIPTS[boundScript][0]}\n请选择风驰版本：`, variantMarkup(boundScript, false, false));
    return;
  }
  if (data.startsWith("kernel:")) {
    const key = data.slice(7);
    if (!SCRIPTS[key] || !session.serial) { await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return; }
    const boundScript = isAdmin(env, userId) ? null : await workflowForUser(env, userId);
    if (boundScript && boundScript !== key) { await answerCallback(env, query.id, "该账号已绑定其他构建脚本", true); return; }
    const variants = SCRIPTS[key][1];
    session.options = defaults(); session.selectedScript = key;
    if (variants) {
      delete session.workflow;
      await setSession(env, userId, session);
      await editMessage(env, chatId, messageId, `已选择：${SCRIPTS[key][0]}\n请选择风驰版本：`, variantMarkup(key, isAdmin(env, userId) || !boundScript, !isAdmin(env, userId) && !boundScript));
      return;
    }
    if (await workflowMaintenance(env, key)) { await answerCallback(env, query.id, "该内核正在建立持久缓存，请稍后再试", true); return; }
    session.workflow = key; session.options ||= defaults();
    applyWorkflowDefaults(key, session.options);
    await setSession(env, userId, session);
    await editMessage(env, chatId, messageId, `已选择：${WORKFLOWS[key][0]}\n继续选择功能：`, optionsMarkup(session.options, isAdmin(env, userId) && supportsSelfConfig(key))); return;
  }
  if (data.startsWith("variant:")) {
    const [, scriptKey, variantKey] = data.split(":");
    const variants = SCRIPTS[scriptKey]?.[1];
    if (!variants || !variants[variantKey] || !session.serial) { await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return; }
    const workflowKey = variants[variantKey][1];
    if (!isAdmin(env, userId)) {
      const boundScript = await workflowForUser(env, userId);
      if (!boundScript) { await answerCallback(env, query.id, "请先点击“绑定此脚本”", true); return; }
      if (boundScript !== scriptKey) { await answerCallback(env, query.id, "该账号已绑定其他构建脚本", true); return; }
    }
    if (await workflowMaintenance(env, workflowKey)) { await answerCallback(env, query.id, "该内核正在建立持久缓存，请稍后再试", true); return; }
    session.workflow = workflowKey; session.options ||= defaults();
    applyWorkflowDefaults(workflowKey, session.options);
    await setSession(env, userId, session);
    await editMessage(env, chatId, messageId, `已选择：${WORKFLOWS[workflowKey][0]}\n继续选择功能：`, optionsMarkup(session.options, isAdmin(env, userId) && supportsSelfConfig(workflowKey))); return;
  }
  if (!isAdmin(env, userId)) {
    const boundScript = await workflowForUser(env, userId);
    const selectedScript = WORKFLOW_SCRIPTS[session.workflow || ""];
    if (!boundScript || selectedScript !== boundScript) {
      delete session.workflow;
      await setSession(env, userId, session);
      await editMessage(env, chatId, messageId, "尚未绑定脚本，请先选择机型并点击“绑定此脚本”。", workflowMarkup());
      return;
    }
  }
  const options = session.options;
  if (!options) { await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return; }
  if (data.startsWith("toggle:")) {
    const key = data.slice(7); if (!BOOL_LABELS[key]) return;
    if (key === "self_config" && !isAdmin(env, userId)) { await answerCallback(env, query.id, "该配置仅限所有者使用", true); return; }
    const value = options[key] === "true" ? "false" : "true";
    if (key === "zarm_tool" && value === "true" && options.lz4kd_enable !== "true") { await answerCallback(env, query.id, "请先开启 LZ4KD", true); return; }
    options[key] = value;
    if (value === "true" && key === "susfs_enable") options.nomount_enable = "false";
    if (value === "true" && key === "nomount_enable") options.susfs_enable = "false";
    if (key === "lz4kd_enable" && value === "false") options.zarm_tool = "false";
  } else if (data.startsWith("cycle:")) {
    const key = data.slice(6); const choices = key === "ksu_type" ? KSU_VALUES : key === "bbr_enable" ? BBR_VALUES : key === "droidspaces_enable" ? DROID_VALUES : null;
    if (!choices) return; options[key] = choices[(choices.indexOf(options[key]) + 1) % choices.length];
  } else if (data === "dispatch") { await dispatchBuild(env, query, session); return; }
  await setSession(env, userId, session);
  await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: optionsMarkup(options, isAdmin(env, userId) && supportsSelfConfig(session.workflow || "")) });
}

async function handleJoinRequest(env: Env, update: any) {
  const request = update.chat_join_request; if (String(request.chat.id) !== String(env.REQUIRED_CHANNEL_ID)) return;
  const boundSerial = await serialForUser(env, request.from.id);
  if (boundSerial && await serialRecord(env, boundSerial)) {
    try {
      await tg(env, "approveChatJoinRequest", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: request.from.id });
      await env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(request.from.id).run();
      await clearSession(env, request.from.id);
      await sendMessage(env, request.user_chat_id, "序列号验证通过，已批准进入频道。加入后可使用 /build。");
      return;
    } catch (error) {
      console.error("approve immediate join request failed", request.from.id, String(error));
    }
  }
  await env.DB.prepare(
    "INSERT INTO pending_joins(telegram_user_id,user_chat_id,requested_at) VALUES(?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET user_chat_id=excluded.user_chat_id,requested_at=excluded.requested_at"
  ).bind(request.from.id, request.user_chat_id, now()).run();
  await setSession(env, request.from.id, { awaitingJoinSerial: true });
  try {
    await sendMessage(env, request.user_chat_id, "请输入设备序列号：");
  } catch (error) {
    console.log("join requester must start bot before it can be messaged", request.from.id, String(error));
  }
}

async function handleDocument(env: Env, update: any) {
  const message = update.message; const userId = message.from.id;
  if (!isAdmin(env, userId)) { await sendMessage(env, message.chat.id, "无权导入白名单。"); return; }
  const doc = message.document; const name = String(doc.file_name || "").toLowerCase();
  if (!name.endsWith(".txt") && !name.endsWith(".csv")) { await sendMessage(env, message.chat.id, "仅支持 UTF-8 编码的 .txt 或 .csv 白名单文件。"); return; }
  if (Number(doc.file_size || 0) > 1024 * 1024) { await sendMessage(env, message.chat.id, "白名单文件不能超过 1 MiB。"); return; }
  const file = await tg(env, "getFile", { file_id: doc.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  const text = await response.text(); let added = 0; let invalid = 0;
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const serial = raw.trim().split(/[,\t]/, 1)[0].trim(); if (!serial || serial.startsWith("#")) continue;
    if (!SERIAL_RE.test(serial)) { invalid++; continue; }
    await allowSerial(env, serial, userId); added++;
  }
  await sendMessage(env, message.chat.id, `已导入 ${added} 条序列号${invalid ? `，忽略 ${invalid} 条无效记录` : ""}。`);
}

async function handleUpdate(env: Env, update: any) {
  if (update.chat_join_request) return handleJoinRequest(env, update);
  if (update.callback_query) return handleCallback(env, update);
  const message = update.message; if (!message) return;
  if (message.document) return handleDocument(env, update);
  const text = String(message.text || "");
  if (text.startsWith("/")) {
    const parts = text.trim().split(/\s+/); const command = parts.shift()!.slice(1).split("@")[0].toLowerCase();
    return handleCommand(env, update, command, parts);
  }
  return handleText(env, update);
}

function ghHeaders(env: Env) {
  return { "accept": "application/vnd.github+json", "authorization": `Bearer ${env.GITHUB_TOKEN}`, "x-github-api-version": "2022-11-28", "user-agent": "oneplus-gki-worker" };
}
async function sendDocument(env: Env, chatId: number, filename: string, bytes: Uint8Array, caption?: string) {
  const form = new FormData(); form.set("chat_id", String(chatId));
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.set("document", new Blob([payload], { type: "application/zip" }), filename);
  if (caption) form.set("caption", caption);
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`sendDocument ${response.status}: ${await response.text()}`);
}
function unwrapArtifact(bytes: Uint8Array, pattern: RegExp): { name: string; bytes: Uint8Array } | null {
  const files = unzipSync(bytes); const matches = Object.entries(files).filter(([name]) => pattern.test(name.split("/").pop() || ""));
  if (matches.length !== 1) return null;
  return { name: matches[0][0].split("/").pop()!, bytes: matches[0][1] };
}

async function processJob(env: Env, job: any) {
  const root = `https://api.github.com/repos/${env.GITHUB_REPO}`; let run: any; let runId = job.github_run_id;
  if (!runId) {
    const response = await fetch(`${root}/actions/workflows/${job.workflow_file}/runs?event=workflow_dispatch&per_page=50`, { headers: ghHeaders(env) });
    if (!response.ok) throw new Error(`runs ${response.status}`);
    const runs: any[] = (await response.json() as any).workflow_runs || [];
    run = runs.find(r => String(r.display_title || "").includes(job.request_id));
    if (!run) {
      for (const candidate of runs.filter(r => Date.parse(r.created_at) / 1000 >= job.created_at - 120)) {
        const jr = await fetch(`${root}/actions/runs/${candidate.id}/jobs?per_page=10`, { headers: ghHeaders(env) });
        if (!jr.ok) continue; const jobs: any[] = (await jr.json() as any).jobs || [];
        if (jobs.some(j => String(j.name || "").includes(job.request_id))) { run = candidate; break; }
      }
    }
    if (!run) {
      if (now() - job.created_at > 900) { await sendMessage(env, job.chat_id, "未能关联本次构建，请联系管理员。"); await finishJob(env, job.request_id, "failed"); }
      return;
    }
    runId = run.id;
    await env.DB.prepare("UPDATE build_jobs SET github_run_id=?,status='running',updated_at=? WHERE request_id=?").bind(runId, now(), job.request_id).run();
  } else {
    const response = await fetch(`${root}/actions/runs/${runId}`, { headers: ghHeaders(env) });
    if (!response.ok) throw new Error(`run ${response.status}`); run = await response.json();
  }
  if (run.status !== "completed") return;
  if (run.conclusion !== "success") { await sendMessage(env, job.chat_id, "本次构建失败，请联系管理员。"); await finishJob(env, job.request_id, "failed", runId); return; }
  const claimed = await env.DB.prepare(
    "UPDATE build_jobs SET status='delivering',updated_at=? WHERE request_id=? AND (status IN ('running','delivery_pending') OR (status='delivering' AND updated_at<=?))"
  ).bind(now(), job.request_id, now() - 300).run();
  if (!Number(claimed.meta.changes || 0)) return;
  const response = await fetch(`${root}/actions/runs/${runId}/artifacts`, { headers: ghHeaders(env) });
  if (!response.ok) throw new Error(`artifacts ${response.status}`); const artifacts: any[] = (await response.json() as any).artifacts || [];
  let inputs: any = {}; try { inputs = JSON.parse(job.inputs || "{}"); } catch {}
  const packages: Array<[RegExp, RegExp, string | undefined, boolean, boolean]> = [[/^(AnyKernel3|ak3)_.*\.zip$/i, /^(AnyKernel3|ak3)_.*\.zip$/i, isAdmin(env, job.chat_id) ? "构建完成，刷机前请确认机型和序列号。" : undefined, false, true]];
  if (String(inputs.nomount_enable).toLowerCase() === "true") packages.push([/^NoMount(?:-Suite)?(?:[-_].*)?(?:\.zip)?$/i, /^NoMount(?:-Suite)?(?:[-_].*)?\.zip$/i, isAdmin(env, job.chat_id) ? "NoMount 模块已随本次构建生成。" : undefined, false, true]);
  for (const [artifactPattern, filePattern, caption, unwrap, preserveName] of packages) {
    const artifact = artifacts.find(a => artifactPattern.test(a.name || "") && !a.expired); if (!artifact) return;
    const download = await fetch(artifact.archive_download_url, { headers: ghHeaders(env), redirect: "follow" }); if (!download.ok) throw new Error(`artifact download ${download.status}`);
    const outer = new Uint8Array(await download.arrayBuffer()); const unwrapped = unwrap ? unwrapArtifact(outer, filePattern) : null;
    const originalName = String(artifact.name || "NoMount.zip");
    const filename = preserveName
      ? (originalName.toLowerCase().endsWith(".zip") ? originalName : `${originalName}.zip`)
      : (unwrapped?.name || originalName);
    await sendDocument(env, Number(job.chat_id), filename, unwrapped?.bytes || outer, caption);
  }
  await finishJob(env, job.request_id, "sent", runId);
}
async function finishJob(env: Env, requestId: string, status: string, runId?: number) {
  await env.DB.prepare("UPDATE build_jobs SET status=?,active_user_id=NULL,github_run_id=COALESCE(?,github_run_id),updated_at=? WHERE request_id=?")
    .bind(status, runId || null, now(), requestId).run();
}
async function monitorBuilds(env: Env) {
  const result: any = await env.DB.prepare("SELECT * FROM build_jobs WHERE status IN ('submitted','running','delivery_pending','delivering') ORDER BY created_at LIMIT 10").all();
  for (const job of result.results) {
    try { await processJob(env, job); }
    catch (e) {
      console.error("monitor", job.request_id, e);
      await env.DB.prepare("UPDATE build_jobs SET status='delivery_pending',updated_at=? WHERE request_id=? AND status='delivering'").bind(now(), job.request_id).run();
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const dataMigration = await applyDataMigrations(env);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "oneplus-gki-build-bot", dataMigration });
    }
    if (request.method === "GET" && url.pathname === `/setup-webhook/${env.WEBHOOK_SECRET}`) {
      const webhookUrl = `${url.origin}/telegram/${env.WEBHOOK_SECRET}`;
      await tg(env, "setMyCommands", {
        commands: [
          { command: "start", description: "验证序列号" },
          { command: "join", description: "验证序列号并申请入群" },
        ],
      });
      await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "chat_join_request"],
        drop_pending_updates: false,
      });
      return Response.json({ ok: true, webhook: webhookUrl, allowed_updates: ["message", "callback_query", "chat_join_request"] });
    }
    if (request.method !== "POST" || url.pathname !== `/telegram/${env.WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    const update = await request.json(); ctx.waitUntil(handleUpdate(env, update)); return new Response("OK");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await applyDataMigrations(env);
      await monitorBuilds(env);
    })());
  },
};
