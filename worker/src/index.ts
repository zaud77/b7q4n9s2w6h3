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
};

type Session = {
  awaitingJoinSerial?: boolean;
  serial?: string;
  workflow?: string;
  options?: Record<string, string>;
  ownerDirectedBuild?: boolean;
  deliveryChatId?: number;
};

const SERIAL_RE = /^[A-Za-z0-9._:-]{6,64}$/;
const WORKFLOWS: Record<string, [string, string]> = {
  "623": ["6.12.23 · OnePlus 15", "build.yml"],
  "638a": ["6.12.38 · Ace6T", "fastbuild_6.12.38.yml"],
  "638t": ["6.12.38 · OnePlus 15T（启动兼容测试）", "fastbuild_6.12.38_oneplus_15t.yml"],
  "658": ["6.12.58", "fastbuild_6.12.58.yml"],
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
async function revokeSerial(env: Env, serial: string): Promise<boolean> {
  const hash = await digestSerial(env, serial);
  const record: any = await env.SERIALS.get(`serial:${hash}`, "json");
  if (!record) return false;
  await env.SERIALS.put(`serial:${hash}`, JSON.stringify({ ...record, enabled: false }));
  await env.DB.prepare("UPDATE serial_bindings SET enabled=0 WHERE serial_hash=?").bind(hash).run();
  return true;
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
  rows.push([{ text: "开始构建", callback_data: "dispatch" }, { text: "取消", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}
function workflowMarkup() {
  const rows = Object.entries(WORKFLOWS).map(([key, value]) => [{ text: value[0], callback_data: `kernel:${key}` }]);
  rows.push([{ text: "取消", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

async function workflowForUser(env: Env, userId: number): Promise<string | null> {
  const row: any = await env.DB.prepare("SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=?").bind(userId).first();
  return row?.workflow_key || null;
}
async function bindWorkflow(env: Env, userId: number, key: string): Promise<string> {
  await env.DB.prepare("INSERT OR IGNORE INTO workflow_bindings(telegram_user_id,workflow_key,bound_at) VALUES(?,?,?)")
    .bind(userId, key, now()).run();
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
  if (command === "start") {
    await sendMessage(env, chatId, "OnePlus GKI 构建机器人已部署并启动；发送 /build 可选择内核版本和功能。");
    return;
  }
  if (command === "join") {
    await setSession(env, userId, { awaitingJoinSerial: true });
    await sendMessage(env, chatId, "请输入设备序列号："); return;
  }
  if (command === "build") {
    if (!(await isMember(env, userId))) { await sendMessage(env, chatId, "尚未通过入频道验证，请先使用 /join。"); return; }
    const serial = await serialForUser(env, userId);
    if (!serial) { await sendMessage(env, chatId, "当前 Telegram 账号尚未绑定有效序列号，请先使用 /join。"); return; }
    const bound = isAdmin(env, userId) ? null : await workflowForUser(env, userId);
    const options = defaults();
    if (bound === "638t") { options.lz4_enable = "false"; options.unicode_enable = "false"; }
    const session: Session = { serial, options };
    if (bound) {
      if (!WORKFLOWS[bound]) { await sendMessage(env, chatId, "已绑定的构建脚本当前不可用，请联系管理员。"); return; }
      if (await workflowMaintenance(env, bound)) { await sendMessage(env, chatId, `${WORKFLOWS[bound][0]} 正在建立持久缓存，暂时不能提交构建。`); return; }
      session.workflow = bound; await setSession(env, userId, session);
      await sendMessage(env, chatId, `已绑定：${WORKFLOWS[bound][0]}\n请选择功能：`, optionsMarkup(options, false)); return;
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
    await sendMessage(env, chatId, await revokeSerial(env, serial) ? "已撤销。" : "数据库中没有该序列号。"); return;
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
    const invite = await tg(env, "createChatInviteLink", { chat_id: env.REQUIRED_CHANNEL_ID, name: `serial-approval-${new Date().toISOString().slice(0,10)}`, creates_join_request: true });
    await sendMessage(env, chatId, `这是需要机器人审核的频道申请链接，用户不能直接进入：\n${invite.invite_link}`); return;
  }
  await sendMessage(env, chatId, "不支持该命令。可使用 /start、/join、/build。");
}

async function handleText(env: Env, update: any) {
  if (await rejectWhileBuilding(env, update)) return;
  const message = update.message; const userId = message.from.id; const serial = String(message.text || "").trim();
  const session = await getSession(env, userId);
  if (!session.awaitingJoinSerial) return;
  if (!SERIAL_RE.test(serial)) { await sendMessage(env, message.chat.id, "序列号格式无效，请重新输入。"); return; }
  if (!(await claimSerial(env, serial, userId))) { await sendMessage(env, message.chat.id, "序列号不在白名单中，或已绑定其他 Telegram 用户。"); return; }
  const pending: any = await env.DB.prepare("SELECT user_chat_id FROM pending_joins WHERE telegram_user_id=?").bind(userId).first();
  if (pending) {
    try {
      await tg(env, "approveChatJoinRequest", { chat_id: env.REQUIRED_CHANNEL_ID, user_id: userId });
      await env.DB.prepare("DELETE FROM pending_joins WHERE telegram_user_id=?").bind(userId).run();
      await clearSession(env, userId);
      await sendMessage(env, pending.user_chat_id, "序列号验证通过，已批准进入频道。加入后可使用 /build。");
    } catch { await sendMessage(env, message.chat.id, "序列号已通过，但批准入群失败，请联系管理员。"); }
    return;
  }
  await clearSession(env, userId);
  if (await isMember(env, userId)) await sendMessage(env, message.chat.id, "序列号已绑定，频道成员身份验证通过，可使用 /build。");
  else await sendMessage(env, message.chat.id, "序列号验证通过。请打开管理员发送的频道申请链接并提交加入请求。");
}

async function dispatchBuild(env: Env, query: any, session: Session) {
  const userId = query.from.id; const chatId = query.message.chat.id; const messageId = query.message.message_id;
  if (await activeBuild(env, userId)) { await answerCallback(env, query.id, "当前正在构建内核，请等待本次构建完成。", true); return; }
  const serial = session.serial || ""; const workflowKey = session.workflow || "";
  if (!WORKFLOWS[workflowKey] || !(await serialRecord(env, serial)) || !(await isMember(env, userId))) {
    await clearSession(env, userId); await editMessage(env, chatId, messageId, "最终授权检查失败，未触发构建。"); return;
  }
  if (!isAdmin(env, userId) && (await workflowForUser(env, userId)) !== workflowKey) {
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
    const limit = Number(env.DAILY_BUILD_LIMIT || 2);
    if (Number(count?.total || 0) >= limit) { await editMessage(env, chatId, messageId, `今天已达到 ${limit} 次构建上限，请在北京时间次日再试。`); return; }
  }
  if (await workflowMaintenance(env, workflowKey)) { await editMessage(env, chatId, messageId, `${WORKFLOWS[workflowKey][0]} 正在建立持久缓存，暂时不能提交构建。`); return; }
  const options = { ...(session.options || defaults()) };
  if (!isAdmin(env, userId)) options.self_config = "false";
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
  const data = query.data || ""; const session = await getSession(env, userId);
  if (data === "cancel") { await clearSession(env, userId); await editMessage(env, chatId, messageId, "已取消。"); return; }
  if (data.startsWith("kernel:")) {
    const key = data.slice(7);
    if (!WORKFLOWS[key] || !session.serial) { await editMessage(env, chatId, messageId, "会话已失效，请重新使用 /build。"); return; }
    if (await workflowMaintenance(env, key)) { await answerCallback(env, query.id, "该内核正在建立持久缓存，请稍后再试", true); return; }
    if (!isAdmin(env, userId) && (await bindWorkflow(env, userId, key)) !== key) { await editMessage(env, chatId, messageId, "该账号已绑定其他构建脚本。"); return; }
    session.workflow = key; session.options ||= defaults();
    if (key === "638t") { session.options.lz4_enable = "false"; session.options.unicode_enable = "false"; }
    await setSession(env, userId, session);
    await editMessage(env, chatId, messageId, `已选择：${WORKFLOWS[key][0]}\n继续选择功能：`, optionsMarkup(session.options, isAdmin(env, userId))); return;
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
  await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: optionsMarkup(options, isAdmin(env, userId)) });
}

async function handleJoinRequest(env: Env, update: any) {
  const request = update.chat_join_request; if (String(request.chat.id) !== String(env.REQUIRED_CHANNEL_ID)) return;
  await env.DB.prepare(
    "INSERT INTO pending_joins(telegram_user_id,user_chat_id,requested_at) VALUES(?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET user_chat_id=excluded.user_chat_id,requested_at=excluded.requested_at"
  ).bind(request.from.id, request.user_chat_id, now()).run();
  await setSession(env, request.from.id, { awaitingJoinSerial: true });
  await sendMessage(env, request.user_chat_id, "请输入设备序列号：");
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
  const response = await fetch(`${root}/actions/runs/${runId}/artifacts`, { headers: ghHeaders(env) });
  if (!response.ok) throw new Error(`artifacts ${response.status}`); const artifacts: any[] = (await response.json() as any).artifacts || [];
  let inputs: any = {}; try { inputs = JSON.parse(job.inputs || "{}"); } catch {}
  const packages: Array<[RegExp, RegExp, string | undefined, boolean]> = [[/^(AnyKernel3|ak3)_.*\.zip$/i, /^(AnyKernel3|ak3)_.*\.zip$/i, isAdmin(env, job.chat_id) ? "构建完成，刷机前请确认机型和序列号。" : undefined, false]];
  if (String(inputs.nomount_enable).toLowerCase() === "true") packages.push([/^NoMount(?:-Suite)?(?:[-_].*)?(?:\.zip)?$/i, /^NoMount(?:-Suite)?(?:[-_].*)?\.zip$/i, isAdmin(env, job.chat_id) ? "NoMount 模块已随本次构建生成。" : undefined, true]);
  for (const [artifactPattern, filePattern, caption, unwrap] of packages) {
    const artifact = artifacts.find(a => artifactPattern.test(a.name || "") && !a.expired); if (!artifact) return;
    const download = await fetch(artifact.archive_download_url, { headers: ghHeaders(env), redirect: "follow" }); if (!download.ok) throw new Error(`artifact download ${download.status}`);
    const outer = new Uint8Array(await download.arrayBuffer()); const unwrapped = unwrap ? unwrapArtifact(outer, filePattern) : null;
    const filename = unwrapped?.name || (String(artifact.name).toLowerCase().endsWith(".zip") ? String(artifact.name) : `${artifact.name}.zip`);
    await sendDocument(env, Number(job.chat_id), filename, unwrapped?.bytes || outer, caption);
  }
  await finishJob(env, job.request_id, "sent", runId);
}
async function finishJob(env: Env, requestId: string, status: string, runId?: number) {
  await env.DB.prepare("UPDATE build_jobs SET status=?,active_user_id=NULL,github_run_id=COALESCE(?,github_run_id),updated_at=? WHERE request_id=?")
    .bind(status, runId || null, now(), requestId).run();
}
async function monitorBuilds(env: Env) {
  const result: any = await env.DB.prepare("SELECT * FROM build_jobs WHERE status IN ('submitted','running','delivery_pending') ORDER BY created_at LIMIT 10").all();
  for (const job of result.results) { try { await processJob(env, job); } catch (e) { console.error("monitor", job.request_id, e); } }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, service: "oneplus-gki-build-bot" });
    if (request.method !== "POST" || url.pathname !== `/telegram/${env.WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    const update = await request.json(); ctx.waitUntil(handleUpdate(env, update)); return new Response("OK");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(monitorBuilds(env)); },
};
