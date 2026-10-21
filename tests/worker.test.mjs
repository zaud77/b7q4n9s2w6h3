import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { zipSync, strToU8 } from "fflate";

const require = createRequire(import.meta.url);
const source = (await readFile(new URL("../worker/src/index.ts", import.meta.url), "utf8"))
  .replace('from "fflate"', `from ${JSON.stringify(pathToFileURL(require.resolve("fflate")).href)}`)
  + "\nexport { handleCommand, handleCallback, dispatchBuild, dispatchNoMountBuild, nomountInputs, validateNoMountPackage, processJob, buildArtifactCatalog, downloadBuildArtifact, ghHeaders, digestSerial, buildQuotaMessage, beijingDayBounds, unwrapArtifact, NOMOUNT_PACKAGE_RE, normalizeBuildOptions };";
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const worker = await import("data:text/javascript;base64," + Buffer.from(compiled.outputText).toString("base64"));
const requestId = "a123456789012345";
const serial = "TEST_DEVICE_123";
const query = { from: { id: 42 }, message: { chat: { id: 42, type: "private" }, message_id: 7 } };

async function fixture(t, overrides = {}) {
  const state = { bound: serial, workflowBinding: "623", enabled: true, member: true, count: 0, latest: null, sessions: new Map(), botState: new Map(), jobs: [], calls: [], dispatchStatus: 204, ...overrides };
  const env = { ADMIN_USER_IDS: "1", SERIAL_PEPPER: "fixture-pepper", GITHUB_TOKEN: "old-kernel-fixture-token",
    KERNEL_GITHUB_TOKEN: "new-kernel-fixture-token", LKM_GITHUB_TOKEN: "new-lkm-fixture-token",
    GITHUB_REPO: "zaud77/k6r9m2p7v4x8", LKM_GITHUB_REPO: "zaud77/m8v3p6r9x2k4",
    LKM_GITHUB_REF: "main", GITHUB_REF: "main", TELEGRAM_BOT_TOKEN: "fixture", BUILD_COOLDOWN_SECONDS: "600", DAILY_BUILD_LIMIT: "2" };
  const hash = await worker.digestSerial(env, serial);
  env.SERIALS = { async get(key) { return key === `serial:${hash}` && state.enabled ? { serial, enabled: true } : null; } };
  env.DB = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() {
        if (sql.includes("SELECT value FROM bot_state")) return { value: state.botState.get(values[0]) || "done" };
        if (sql.includes("SELECT serial_value")) return state.bound ? { serial_value: state.bound } : null;
        if (sql.includes("SELECT workflow_key")) return state.workflowBinding ? { workflow_key: state.workflowBinding } : null;
        if (sql.includes("SELECT 1 AS yes FROM build_jobs")) return state.jobs.some(job => job.active_user_id === values[0]) ? { yes: 1 } : null;
        if (sql.includes("SELECT data FROM sessions")) return state.sessions.has(values[0]) ? { data: state.sessions.get(values[0]), updated_at: Math.floor(Date.now() / 1000) } : null;
        if (sql.includes("SELECT MAX(created_at)")) return { latest: state.latest };
        if (sql.includes("SELECT COUNT(*)")) return { total: state.count };
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO sessions")) state.sessions.set(values[0], values[1]);
        if (sql.includes("INSERT INTO workflow_bindings")) state.workflowBinding ||= values[1];
        if (sql.includes("DELETE FROM sessions") && (values.length === 1 || state.sessions.get(values[0]) === values[1])) state.sessions.delete(values[0]);
        if (sql.includes("INSERT INTO build_jobs")) {
          if (state.jobs.some(job => values[2] != null && job.active_user_id === values[2] || job.request_id === values[0])) throw new Error("unique job constraint");
          state.jobs.push({ request_id: values[0], telegram_user_id: values[1], active_user_id: values[2], chat_id: values[3], workflow_file: values[4], inputs: values[5], status: "submitted", created_at: values[6] });
        }
        if (sql.includes("SET status='delivering'")) {
          const job = state.jobs.find(item => item.request_id === values[2]);
          if (!job || !(job.status === "running" || job.status === "delivery_pending" ||
              (job.status === "delivering" && job.updated_at <= values[3]))) return { meta: { changes: 0 } };
          job.status = "delivering";
          job.succeeded_at ??= values[0];
          job.updated_at = values[1];
        }
        if (sql.includes("SET status=?,active_user_id=NULL")) {
          const job = state.jobs.find(item => item.request_id === values[3]);
          if (job) { job.status = values[0]; job.active_user_id = null; }
        }
        return { meta: { changes: 1 } };
      },
    };
  } };
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    state.calls.push({ url: String(url), options, body });
    if (String(url).includes("api.telegram.org")) {
      const result = String(url).endsWith("getChatMember") ? { status: state.member ? "member" : "left" } : { chat: { type: "private", id: 42 }, message_id: state.messageId || 8 };
      return Response.json({ ok: true, result });
    }
    if (String(url).endsWith("/dispatches")) {
      if (state.dispatchError) throw state.dispatchError;
      return new Response(null, { status: state.dispatchStatus });
    }
    if (state.githubResponse) return state.githubResponse(String(url), options);
    throw new Error("Unexpected fixture HTTP request");
  };
  t.after(() => { globalThis.fetch = previous; });
  return { env, state };
}

async function quotaFixture(t) {
  t.mock.method(Date, "now", () => Date.parse("2026-10-15T04:00:00Z"));
  const { env, state } = await fixture(t);
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  env.DB = { prepare(sql) {
    const statement = database.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) || null; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
      async all() { return { results: statement.all(...values) }; },
    };
  }, async batch(statements) {
    database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } };
  const timestamp = Math.floor(Date.now() / 1000);
  database.prepare("INSERT INTO serial_bindings(serial_hash,serial_value,owner_user_id,created_at,created_by) VALUES(?,?,?,?,?)")
    .run(await worker.digestSerial(env, serial), serial, 42, timestamp, 1);
  database.prepare("INSERT INTO workflow_bindings(telegram_user_id,workflow_key,bound_at) VALUES(?,?,?)").run(42, "623", timestamp);
  let nextId = 0;
  function addJob({ userId = 42, status = "failed", runId = 99, succeededAt = null, createdAt = timestamp - 1200, kind = "kernel" } = {}) {
    const id = `quota-job-${++nextId}`;
    database.prepare("INSERT INTO build_jobs(request_id,telegram_user_id,chat_id,workflow_file,inputs,github_run_id,status,succeeded_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, userId, userId, kind === "kernel" ? "kernel.yml" : "lkm.yml", JSON.stringify({ build_kind: kind }),
        runId, status, succeededAt, createdAt, createdAt);
  }
  function countFailures(userId = 42, enabled = true) {
    database.prepare("INSERT INTO bot_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`quota_count_failures:${userId}`, enabled ? "1" : "0");
  }
  return { env, state, database, timestamp, addJob, countFailures };
}

function dispatches(state) { return state.calls.filter(call => call.url.endsWith("/dispatches")); }
function session() { return { serial, nomountRequestId: requestId }; }
function kernelSession() { return { serial, workflow: "623g", options: { ksu_type: "kowsu", nomount_enable: "true", susfs_enable: "false" } }; }
function packageBytes(digest, extra = {}) {
  return zipSync({ "lkm/binding.conf": strToU8(`smoke_only=0\nserial_sha256=${digest}\n`),
    "lkm/nomount.ko": strToU8("fixture-ko"), "classes.dex": strToU8("fixture-dex"),
    "zygisk/arm64-v8a.so": strToU8("fixture-bridge"), "module.prop": strToU8("version=1.80\n"), ...extra });
}
function embeddedPackageBytes(digest, properties = "", extra = {}) {
  const files = { "lkm/nomount.ko": strToU8("fixture-ko"), "classes.dex": strToU8("fixture-dex"),
    "zygisk/arm64-v8a.so": strToU8("fixture-bridge"),
    "module.prop": strToU8(properties || `version=1.80\nnomount_binding=${"a".repeat(64)}\nnomount_serial_sha256=${digest}\nnomount_smoke_only=0\nnomount_diagnostic=0\nnomount_stage=full\nnomount_kmi=android16-6.12\n`), ...extra };
  return zipSync(files);
}

function assertPrivateMessages(state) {
  for (const call of state.calls.filter(call => call.url.includes("api.telegram.org"))) {
    const body = call.body;
    const texts = body instanceof FormData ? [body.get("caption")] :
      [body?.text, ...(body?.reply_markup?.inline_keyboard || []).flat().map(button => button.text)];
    for (const text of texts.filter(value => typeof value === "string")) {
      assert.doesNotMatch(text, /github|actions|仓库|工作流|zaud77|m8v3p6r9x2k4|k6r9m2p7v4x8/i);
    }
  }
}

async function deliveryFixture(t, options = {}) {
  const { filename, digestOnly, packageOverride, kernelArtifactBytes, kernelSeries = "6.12", conclusion = "success", ...overrides } = options;
  const { env, state } = await fixture(t, overrides);
  const inputs = await worker.nomountInputs(serial, requestId, kernelSeries);
  if (digestOnly) delete inputs.device_serial;
  const payload = packageOverride || packageBytes(inputs.device_serial_sha256);
  const name = filename || `NoMount-Suite-v1.80-LKM-${serial}.zip`;
  const outer = zipSync({ [name]: payload });
  const job = { request_id: requestId, telegram_user_id: 42, chat_id: 42, workflow_file: "lkm.yml", github_run_id: 99,
    status: "delivery_pending", active_user_id: 42,
    inputs: JSON.stringify({ ...inputs, build_kind: "nomount-lkm", github_repo: "zaud77/m8v3p6r9x2k4" }) };
  state.jobs.push(job);
  state.githubResponse = async url => {
    if (url.endsWith("/runs/99")) return Response.json({ status: "completed", conclusion });
    if (url.endsWith("/artifacts")) return Response.json({ artifacts: [
      { name: "nomount-suite-lkm", archive_download_url: "https://api.github.com/download/fixture" },
      ...(kernelArtifactBytes ? [{ name: kernelSeries === "6.18" ? "nomount-android17-6.18-kernel" : "nomount-android16-6.12-kernel", archive_download_url: "https://api.github.com/download/kernel-fixture" }] : []),
    ] });
    if (url.endsWith("/download/fixture")) return new Response(outer);
    if (url.endsWith("/download/kernel-fixture")) return new Response(kernelArtifactBytes);
    throw new Error("Unexpected fixture request");
  };
  return { env, state, job, payload, outer, name };
}

function privateDelivery(env, state, outer, kernelArtifactBytes, options = {}) {
  const root = "https://api.github.com/repos/private/lkm";
  env.PRIVATE_BUILD_TOKEN = "private-build-fixture-token";
  env.PRIVATE_LKM_REPOSITORY = "private/lkm";
  const artifact = (name, id, bytes) => ({ id, name: `artifact-${name}.zip`, label: `Build artifact: ${name}`,
    state: "uploaded", digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") });
  state.githubResponse = async (url, request) => {
    if (url.endsWith("/actions/runs/99")) return Response.json({ id: 99, status: "completed", conclusion: "success",
      run_attempt: 2, repository: { id: 123, full_name: env.LKM_GITHUB_REPO } });
    assert.equal(request.headers.authorization, "Bearer private-build-fixture-token");
    if (url === root) return Response.json({ private: options.publicRepository !== true });
    const match = url.match(/\/releases\/tags\/(build-diagnostics-123-99-([12]))$/);
    if (match) return Response.json({ id: Number(match[2]), tag_name: match[1],
      body: `Encrypted build diagnostics v1\nOrigin: ${options.origin || env.LKM_GITHUB_REPO}\nRun: 99\nAttempt: ${match[2]}\n` });
    if (url === `${root}/releases/2/assets?per_page=100&page=1`)
      return Response.json([artifact("nomount-suite-lkm", 201, outer),
        { id: 299, name: "run-99-suite-0-attempt-2.zip", state: "uploaded" }]);
    if (url === `${root}/releases/1/assets?per_page=100&page=1`)
      return Response.json(kernelArtifactBytes ? [artifact("nomount-android17-6.18-kernel", 202, kernelArtifactBytes)] : []);
    if (url === `${root}/releases/assets/201`) return new Response(options.corrupt ? strToU8("wrong") : outer);
    if (url === `${root}/releases/assets/202`) return new Response(kernelArtifactBytes);
    throw new Error("Unexpected private artifact request");
  };
}

test("bound users get a private, serial-free confirmation", async t => {
  const { env, state } = await fixture(t);
  await worker.handleCommand(env, { message: { from: { id: 42 }, chat: { id: 42, type: "private" } } }, "nomount", []);
  const saved = JSON.parse(state.sessions.get(42));
  assert.equal(saved.serial, serial);
  assert.match(saved.nomountRequestId, /^[a-f0-9]{16}$/);
  assert.equal(dispatches(state).length, 0);
  const menu = state.calls.find(call => call.body?.text === "选择 NoMount 内核版本：").body;
  const prompt = menu.text;
  assert.deepEqual(menu.reply_markup.inline_keyboard[0].map(button => button.text), ["NoMount · 6.12", "NoMount · 6.18"]);
  assert.ok(prompt.length < 50);
  assert.equal(prompt.includes("\n"), false);
  assert.equal(prompt.includes(serial), false);
  assertPrivateMessages(state);
});

test("NoMount kernel selection is nonce-bound and dispatches the selected target", async t => {
  const { env, state } = await fixture(t);
  state.sessions.set(42, JSON.stringify(session()));
  for (const data of [`nomount_kernel:6.19:${requestId}`, `nomount_kernel:6.18:${"b".repeat(16)}`]) {
    await worker.handleCallback(env, { callback_query: { ...query, id: "select", data } });
    assert.equal(JSON.parse(state.sessions.get(42)).nomountKernelSeries, undefined);
  }
  await worker.handleCallback(env, { callback_query: { ...query, id: "select", data: `nomount_kernel:6.18:${requestId}` } });
  const selected = JSON.parse(state.sessions.get(42));
  assert.equal(selected.nomountKernelSeries, "6.18");
  assert.equal(dispatches(state).length, 0);
  await worker.dispatchNoMountBuild(env, query, selected, requestId);
  assert.equal(dispatches(state).length, 0);
  await worker.dispatchNoMountBuild(env, query, selected, selected.nomountRequestId);
  assert.equal(dispatches(state)[0].body.inputs.kernel_series, "6.18");
  assert.equal(JSON.parse(state.jobs[0].inputs).kernel_series, "6.18");
  assertPrivateMessages(state);
});

test("buildfor offers owner-directed NoMount LKM and binds it to the selected whitelist serial", async t => {
  const { env, state } = await fixture(t, { bound: null });
  const ownerQuery = { from: { id: 1 }, message: { chat: { id: 1, type: "private" }, message_id: 7 } };
  await worker.handleCommand(env, { message: { ...ownerQuery.message, from: ownerQuery.from } }, "buildfor", [serial]);
  const menu = state.calls.find(call => call.body?.text?.includes("请选择内核脚本"));
  assert.ok(menu);
  assert.ok(menu.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "owner_nomount"));
  assert.equal(JSON.parse(state.sessions.get(1)).serial, serial);

  await worker.handleCallback(env, { callback_query: { id: "cb-1", from: ownerQuery.from, message: ownerQuery.message, data: "owner_nomount" } });
  let saved = JSON.parse(state.sessions.get(1));
  assert.equal(saved.serial, serial);
  assert.equal(saved.ownerDirectedBuild, true);
  assert.equal(saved.deliveryChatId, 1);
  assert.match(saved.nomountRequestId, /^[a-f0-9]{16}$/);
  await worker.handleCallback(env, { callback_query: { ...ownerQuery, id: "select", data: `nomount_kernel:6.12:${saved.nomountRequestId}` } });
  saved = JSON.parse(state.sessions.get(1));
  const confirmation = state.calls.find(call => call.body?.text === "构建 NoMount LKM 6.12？");
  assert.ok(confirmation.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === `nomount:${saved.nomountRequestId}`));

  await worker.dispatchNoMountBuild(env, { ...ownerQuery, message: { ...ownerQuery.message, message_id: 8 } }, saved, saved.nomountRequestId);
  const [dispatch] = dispatches(state);
  assert.equal(dispatch.url, "https://api.github.com/repos/zaud77/m8v3p6r9x2k4/actions/workflows/lkm.yml/dispatches");
  assert.equal(dispatch.body.inputs.device_serial, serial);
  assert.equal(JSON.parse(state.jobs[0].inputs).build_kind, "nomount-lkm");
  assert.equal(state.jobs[0].chat_id, 1);
  assert.equal(state.calls.at(-1).body.text, "NoMount 6.12 已提交，完成后自动发包。");
});

test("owner-directed NoMount still rejects non-admins and serials outside the whitelist", async t => {
  const { env, state } = await fixture(t, { bound: null });
  const request = { ...session(), ownerDirectedBuild: true, deliveryChatId: 42 };
  await worker.dispatchNoMountBuild(env, query, request, requestId);
  await worker.dispatchNoMountBuild(env, { ...query, from: { id: 1 }, message: { ...query.message, chat: { id: 1, type: "private" } } },
    { ...request, serial: "OTHER_DEVICE_456", deliveryChatId: 1 }, requestId);
  assert.equal(dispatches(state).length, 0);
  assert.equal(state.jobs.length, 0);
});

test("regular users do not see the owner-directed NoMount option", async t => {
  const { env, state } = await fixture(t);
  await worker.handleCommand(env, { message: { from: { id: 42 }, chat: { id: 42, type: "private" } } }, "build", []);
  const menu = state.calls.find(call => call.body?.text?.includes("请选择风驰版本"));
  assert.ok(menu);
  assert.equal(menu.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === "owner_nomount"), false);
});

for (const [name, overrides] of [["unbound user", { bound: null }], ["revoked serial", { enabled: false }], ["non-member", { member: false }]]) {
  test(`${name} cannot dispatch NoMount`, async t => {
    const { env, state } = await fixture(t, overrides);
    await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 0);
    assert.equal(state.jobs.length, 0);
  });
}

test("another serial, stale button, or group cannot dispatch", async t => {
  const { env, state } = await fixture(t);
  await worker.dispatchNoMountBuild(env, query, { ...session(), serial: "OTHER_DEVICE_456" }, requestId);
  await worker.dispatchNoMountBuild(env, query, session(), "b123456789012345");
  await worker.dispatchNoMountBuild(env, { ...query, message: { ...query.message, chat: { id: -42, type: "group" } } }, session(), requestId);
  assert.equal(dispatches(state).length, 0);
});

test("payload includes the bound serial for display and its SHA256 for validation", async t => {
  const { env, state } = await fixture(t);
  await worker.dispatchNoMountBuild(env, query, session(), requestId);
  const [call] = dispatches(state);
  assert.equal(call.url, "https://api.github.com/repos/zaud77/m8v3p6r9x2k4/actions/workflows/lkm.yml/dispatches");
  assert.equal(call.options.headers.authorization, "Bearer new-lkm-fixture-token");
  assert.deepEqual(Object.keys(call.body.inputs).sort(), ["build_request_id", "device_serial", "device_serial_sha256", "kernel_series"]);
  assert.equal(call.body.inputs.device_serial, serial);
  assert.equal(JSON.parse(state.jobs[0].inputs).device_serial, serial);
  assert.equal(state.jobs[0].chat_id, 42);
  assert.equal(state.calls.at(-1).body.text, "NoMount 6.12 已提交，完成后自动发包。");
  assertPrivateMessages(state);
});

test("concurrent repeat clicks cause only one dispatch", async t => {
  const { env, state } = await fixture(t);
  await Promise.all([worker.dispatchNoMountBuild(env, query, session(), requestId), worker.dispatchNoMountBuild(env, query, session(), requestId)]);
  assert.equal(dispatches(state).length, 1);
  assert.equal(state.jobs.length, 1);
});

for (const [name, overrides] of [["daily quota", { count: 2 }], ["cooldown", { latest: Math.floor(Date.now() / 1000) }]]) {
  test(`${name} is shared with kernel builds`, async t => {
    const { env, state } = await fixture(t, overrides);
    await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 0);
  });
}

test("rejected dispatch releases the active slot without charging success", async t => {
  const { env, state } = await fixture(t, { dispatchStatus: 403 });
  await worker.dispatchNoMountBuild(env, query, session(), requestId);
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].active_user_id, null);
});

test("LKM never falls back to the suspended account token", async t => {
  const { env, state } = await fixture(t);
  delete env.LKM_GITHUB_TOKEN;
  assert.throws(() => worker.ghHeaders(env, true));
  await worker.dispatchNoMountBuild(env, query, session(), requestId);
  assert.equal(dispatches(state).length, 0);
});

test("delivery refuses wrong bindings, smoke packages and extra KOs", async () => {
  const inputs = await worker.nomountInputs(serial, requestId);
  const digest = inputs.device_serial_sha256;
  assert.doesNotThrow(() => worker.validateNoMountPackage(packageBytes(digest), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes("b".repeat(64)), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(digest, { "lkm/binding.conf": strToU8(`smoke_only=1\nserial_sha256=${digest}`) }), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(digest, { "second.ko": strToU8("extra") }), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(digest, { "lkm/binding.conf": strToU8("a".repeat(4097)) }), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(digest, { "classes.dex": new Uint8Array() }), digest));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(digest, { "lkm/binding.conf": strToU8(`smoke_only=0\nserial_sha256=${digest}\ndiagnostic=1\n`) }), digest));
});

test("embedded module properties replace binding.conf without weakening delivery checks", async () => {
  const digest = (await worker.nomountInputs(serial, requestId)).device_serial_sha256;
  const valid = `version=1.80\nnomount_binding=${"a".repeat(64)}\nnomount_serial_sha256=${digest}\nnomount_smoke_only=0\nnomount_diagnostic=0\nnomount_stage=full\nnomount_kmi=android16-6.12\n`;
  assert.doesNotThrow(() => worker.validateNoMountPackage(embeddedPackageBytes(digest), digest));
  for (const properties of [valid.replace(digest, "b".repeat(64)), valid.replace("nomount_smoke_only=0", "nomount_smoke_only=1"),
    valid.replace("nomount_diagnostic=0", "nomount_diagnostic=1"), valid.replace("nomount_stage=full", "nomount_stage=core"),
    valid.replace("nomount_kmi=android16-6.12", "nomount_kmi=other"), valid.replace("nomount_binding=", "nomount_binding=invalid"),
    valid.replace("nomount_smoke_only=0\n", ""), valid + "nomount_smoke_only=0\n", "x".repeat(4097)]) {
    assert.throws(() => worker.validateNoMountPackage(embeddedPackageBytes(digest, properties), digest));
  }
  assert.throws(() => worker.validateNoMountPackage(embeddedPackageBytes(digest, valid, {"lkm/binding.conf":strToU8(`smoke_only=0\nserial_sha256=${digest}\n`)}), digest));
  assert.throws(() => worker.validateNoMountPackage(embeddedPackageBytes(digest, valid, {"second.ko":strToU8("extra")}), digest));
});

test("current runtime-bound package is verified against its exact run kernel artifact", async t => {
  const inputs = await worker.nomountInputs(serial, requestId);
  const kernelModule = strToU8("fixture-ko");
  const binding = "a".repeat(64);
  const buildInfo = { device_serial: serial, serial_sha256: inputs.device_serial_sha256, binding, smoke_only: 0, stage: "off", auth_version: 2 };
  const checksum = createHash("sha256").update(kernelModule).digest("hex");
  const kernelArtifactBytes = zipSync({
    "nomount.ko": kernelModule,
    "build-info.json": strToU8(JSON.stringify(buildInfo)),
    "sha256.txt": strToU8(`${checksum}  artifacts/nomount.ko\n`),
  });
  const packageOverride = zipSync({
    "lkm/nomount.ko": kernelModule,
    "runtime.sh": strToU8(`NM_PACKAGE_BINDING='${binding}'\nNM_PACKAGE_SMOKE_ONLY='0'\nNM_PACKAGE_DIAGNOSTIC='0'\nNM_PACKAGE_STAGE='full'\n${" ".repeat(20000)}`),
    "classes.dex": strToU8("fixture-dex"),
    "zygisk/arm64-v8a.so": strToU8("fixture-bridge"),
    "module.prop": strToU8("version=1.80\n"),
  });
  const { env, state, job, payload } = await deliveryFixture(t, { packageOverride, kernelArtifactBytes });
  await worker.processJob(env, job);
  const sent = state.calls.find(call => call.url.endsWith("/sendDocument"));
  assert.deepEqual(new Uint8Array(await sent.body.get("document").arrayBuffer()), payload);
  assert.equal(job.status, "sent");
  assert.equal(job.active_user_id, null);
  assert.ok(state.calls.some(call => call.url.endsWith("/download/kernel-fixture")));
});

test("6.18 delivery requires the selected target in both package and run attestation", async t => {
  const inputs = await worker.nomountInputs(serial, requestId, "6.18");
  const kernelModule = strToU8("fixture-ko");
  const binding = "a".repeat(64);
  const info = { device_serial: serial, serial_sha256: inputs.device_serial_sha256, binding,
    smoke_only: 0, stage: "off", auth_version: 2, kernel_series: "6.18" };
  const runtime = `NM_LKM_KERNEL='6.18'\nNM_PACKAGE_BINDING='${binding}'\nNM_PACKAGE_SMOKE_ONLY='0'\nNM_PACKAGE_DIAGNOSTIC='0'\nNM_PACKAGE_STAGE='full'\n`;
  const payload = zipSync({ "lkm/nomount.ko": kernelModule, "runtime.sh": strToU8(runtime),
    "classes.dex": strToU8("fixture-dex"), "zygisk/arm64-v8a.so": strToU8("fixture-bridge"), "module.prop": strToU8("version=1.81\n") });
  const attestation = { buildInfo: info, kernelModule };
  assert.doesNotThrow(() => worker.validateNoMountPackage(payload, inputs.device_serial_sha256, attestation, "6.18"));
  assert.throws(() => worker.validateNoMountPackage(payload, inputs.device_serial_sha256, attestation, "6.12"));
  assert.throws(() => worker.validateNoMountPackage(payload, inputs.device_serial_sha256,
    { ...attestation, buildInfo: { ...info, kernel_series: "6.12" } }, "6.18"));
  assert.throws(() => worker.validateNoMountPackage(packageBytes(inputs.device_serial_sha256), inputs.device_serial_sha256, null, "6.18"));
  const checksum = createHash("sha256").update(kernelModule).digest("hex");
  const kernelArtifactBytes = zipSync({ "nomount.ko": kernelModule, "build-info.json": strToU8(JSON.stringify(info)),
    "sha256.txt": strToU8(`${checksum}  artifacts/nomount.ko\n`) });
  for (const usePrivate of [false, true]) {
    const { env, state, job, outer } = await deliveryFixture(t, { kernelSeries: "6.18", packageOverride: payload, kernelArtifactBytes });
    if (usePrivate) privateDelivery(env, state, outer, kernelArtifactBytes);
    await worker.processJob(env, job);
    const sent = state.calls.find(call => call.url.endsWith("/sendDocument"));
    assert.equal(sent.body.get("document").name, `NoMount-Suite-v1.80-LKM-6.18-${serial}.zip`);
    assert.deepEqual(new Uint8Array(await sent.body.get("document").arrayBuffer()), payload);
    assert.equal(job.status, "sent");
    if (usePrivate) {
      assert.equal(state.calls.some(call => call.url.endsWith("/actions/runs/99/artifacts")), false);
      assert.ok(state.calls.some(call => call.url.includes("build-diagnostics-123-99-1")));
      assertPrivateMessages(state);
    }
  }
});

test("private artifacts fail closed on public storage, wrong origin or damaged downloads", async t => {
  for (const options of [{ publicRepository: true }, { origin: "other/builds" }, { corrupt: true }]) {
    const { env, state, job, outer } = await deliveryFixture(t);
    privateDelivery(env, state, outer, null, options);
    await assert.rejects(() => worker.processJob(env, job), /Private build artifact/);
    assert.equal(state.calls.some(call => call.url.endsWith("/sendDocument")), false);
    assert.equal(state.calls.some(call => call.url.endsWith("/actions/runs/99/artifacts")), false);
  }
});

test("private catalog never delivers encrypted diagnostic attachments", async t => {
  const { env, state, outer } = await deliveryFixture(t);
  privateDelivery(env, state, outer, null);
  const catalog = await worker.buildArtifactCatalog(env, env.LKM_GITHUB_REPO,
    { run_attempt: 2, repository: { id: 123 } }, 99, true);
  assert.deepEqual(catalog.artifacts.map(item => item.name), ["nomount-suite-lkm"]);
  assert.equal(catalog.headers.accept, "application/octet-stream");
});

test("embedded package metadata is delivered without a separate binding file", async t => {
  const digest = (await worker.nomountInputs(serial, requestId)).device_serial_sha256;
  const {env,state,job,payload} = await deliveryFixture(t, {packageOverride:embeddedPackageBytes(digest)});
  await worker.processJob(env,job);
  const sent = state.calls.find(call => call.url.endsWith("/sendDocument"));
  assert.deepEqual(new Uint8Array(await sent.body.get("document").arrayBuffer()), payload);
  assert.equal(state.jobs[0].status, "sent");
});

test("successful delivery sends the inner installable ZIP, not the artifact wrapper", async t => {
  const { env, state, job, payload } = await deliveryFixture(t);
  await worker.processJob(env, job);
  const sent = state.calls.find(call => call.url.endsWith("/sendDocument"));
  assert.equal(sent.body.get("document").name, `NoMount-Suite-v1.80-LKM-6.12-${serial}.zip`);
  assert.equal(sent.body.get("caption"), "构建完成。");
  assert.deepEqual(new Uint8Array(await sent.body.get("document").arrayBuffer()), payload);
  assert.equal(state.jobs[0].status, "sent");
  assert.equal(state.jobs[0].active_user_id, null);
  assert.ok(state.jobs[0].succeeded_at);
  assertPrivateMessages(state);
  assert.ok(state.calls.filter(call => call.url.includes("api.github.com")).every(call => call.options.headers.authorization === "Bearer new-lkm-fixture-token"));
});

test("legacy hash-only pending job delivers with its verified bound serial", async t => {
  const inputs = await worker.nomountInputs(serial, requestId);
  const filename = `NoMount-Suite-v1.80-LKM-SHA256-${inputs.device_serial_sha256.slice(0, 16)}.zip`;
  const { env, state, job, payload } = await deliveryFixture(t, { filename, digestOnly: true });
  await worker.processJob(env, job);
  const document = state.calls.find(call => call.url.endsWith("/sendDocument")).body.get("document");
  assert.equal(document.name, `NoMount-Suite-v1.80-LKM-6.12-${serial}.zip`);
  assert.deepEqual(new Uint8Array(await document.arrayBuffer()), payload);
  assert.equal(job.status, "sent");
  assert.equal(job.active_user_id, null);
  await worker.processJob(env, job);
  assert.equal(state.calls.filter(call => call.url.endsWith("/sendDocument")).length, 1);
});

for (const bound of [null, "OTHER_DEVICE_456"]) {
  test(`legacy package keeps its original name when binding is ${bound ? "changed" : "missing"}`, async t => {
    const inputs = await worker.nomountInputs(serial, requestId);
    const filename = `NoMount-Suite-v1.80-LKM-SHA256-${inputs.device_serial_sha256.slice(0, 16)}.zip`;
    const { env, state, job } = await deliveryFixture(t, { filename, digestOnly: true, bound });
    await worker.processJob(env, job);
    const document = state.calls.find(call => call.url.endsWith("/sendDocument")).body.get("document");
    assert.equal(document.name, filename);
    assert.equal(job.status, "sent");
  });
}

test("artifact matching accepts legacy and serial names but refuses ambiguous wrappers", () => {
  const payload = strToU8("fixture-module");
  const legacy = zipSync({ "NoMount-Suite-v1.80-LKM.zip": payload });
  assert.deepEqual(worker.unwrapArtifact(legacy, worker.NOMOUNT_PACKAGE_RE)?.bytes, payload);
  assert.equal(worker.unwrapArtifact(zipSync({ "unrelated.zip": payload }), worker.NOMOUNT_PACKAGE_RE), null);
  const ambiguous = zipSync({ "NoMount-Suite-v1.80-LKM-DEVICE_A.zip": payload, "NoMount-Suite-v1.80-LKM-DEVICE_B.zip": payload });
  assert.equal(worker.unwrapArtifact(ambiguous, worker.NOMOUNT_PACKAGE_RE), null);
  const installableName = "NoMount-Suite-v1.80-LKM-DEVICE_A.zip";
  const smokeName = "NoMount-Suite-v1.80-LKM-DEVICE_A-SMOKE-NOT-FOR-INSTALL.zip";
  const withSmoke = zipSync({ [installableName]: payload, [smokeName]: payload });
  assert.deepEqual(worker.unwrapArtifact(withSmoke, worker.NOMOUNT_PACKAGE_RE), { name: installableName, bytes: payload });
});

test("wrong-device packages are not sent even when their filenames match", async t => {
  const { env, state, job } = await deliveryFixture(t, { packageOverride: packageBytes("b".repeat(64)) });
  await assert.rejects(worker.processJob(env, job), /Wrong device/);
  assert.equal(state.calls.filter(call => call.url.endsWith("/sendDocument")).length, 0);
});

test("failed build sends a concise message without platform details", async t => {
  const { env, state, job } = await deliveryFixture(t, { conclusion: "failure" });
  await worker.processJob(env, job);
  assert.equal(state.calls.at(-1).body.text, "构建失败，请稍后重试。");
  assert.equal(job.status, "failed");
  assert.equal(job.active_user_id, null);
  assertPrivateMessages(state);
});

for (const kind of ["kernel", "lkm"]) {
  for (const dispatchStatus of [403, 404, 500]) {
    test(`${kind} dispatch error ${dispatchStatus} exposes no platform details`, async t => {
      const { env, state } = await fixture(t, { dispatchStatus });
      if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
      else await worker.dispatchNoMountBuild(env, query, session(), requestId);
      assert.equal(state.calls.at(-1).body.text, "提交失败，请稍后重试。");
      assertPrivateMessages(state);
    });
  }
  test(`${kind} dispatch timeout keeps its reservation without exposing the internal error`, async t => {
    const { env, state } = await fixture(t, { dispatchError: new Error("GitHub https://api.github.com internal detail") });
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(state.calls.at(-1).body.text, "提交处理中，请勿重复提交。");
    assert.equal(state.jobs[0].status, "submitted");
    assert.equal(state.jobs[0].active_user_id, 42);
    assertPrivateMessages(state);
  });
}

test("kernel dispatch uses the migrated repository and credential", async t => {
  const { env, state } = await fixture(t);
  await worker.dispatchBuild(env, query, kernelSession());
  const [call] = dispatches(state);
  assert.equal(call.url, "https://api.github.com/repos/zaud77/k6r9m2p7v4x8/actions/workflows/fastbuild_6.12.23_oneplus_15_hmbird_gold.yml/dispatches");
  assert.equal(call.options.headers.authorization, "Bearer new-kernel-fixture-token");
  assert.equal(call.body.inputs.device_serial, serial);
  assert.equal(call.body.inputs.build_kind, undefined);
  assert.equal(call.body.inputs.github_repo, undefined);
  assert.equal(JSON.parse(state.jobs[0].inputs).github_repo, env.GITHUB_REPO);
  assert.equal(state.jobs[0].chat_id, 42);
});

test("AOSP menu keeps its exact name and requires explicit script binding", async t => {
  const { env, state } = await fixture(t, { workflowBinding: null });
  await worker.handleCommand(env, { message: { from: query.from, chat: query.message.chat } }, "build", []);
  const menu = state.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(menu.some(button => button.text === "6.12.69·AOSP" && button.callback_data === "kernel:669aosp"));
  const click = data => worker.handleCallback(env, { callback_query: { ...query, id: "aosp-callback", data } });
  await click("kernel:669aosp");
  assert.match(state.calls.at(-1).body.text, /请选择构建版本/);
  await click("variant:669aosp:gki");
  assert.match(state.calls.at(-1).body.text, /请先点击/);
  await click("bind:669aosp");
  await click("variant:669aosp:gki");
  const buttons = state.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.slice(0, 2).map(button => button.callback_data), ["set:zram_writeback_enable:true", "set:qpace_enable:true"]);
  assert.ok(buttons.some(button => button.text === "默认 ZRAM：保持系统默认" && button.callback_data === "set:zram_default_algorithm:qpace-lz4"));
  assert.ok(buttons.some(button => button.text === "ZRAM 大小：保持系统默认" && button.callback_data === "set:zram_size_gib:4"));
  assert.ok(!buttons.some(button => button.callback_data.startsWith("set:self_config:")));
  assert.equal(state.workflowBinding, "669aosp");
});

test("AOSP dispatch forwards experiments and never inherits the owner-only workflow default", async t => {
  const { env, state } = await fixture(t, { workflowBinding: "669aosp" });
  await worker.dispatchBuild(env, query, { serial, workflow: "669aosp", options: {
    ...worker.normalizeBuildOptions({}, true), self_config: "true", zram_writeback_enable: "true", qpace_enable: "true",
    zram_default_algorithm: "qpace-lz4", zram_size_gib: "16",
  } });
  const [call] = dispatches(state);
  assert.ok(call.url.endsWith("/actions/workflows/build_aosp_6.12.69_gki.yml/dispatches"));
  assert.equal(call.body.inputs.zram_writeback_enable, "true");
  assert.equal(call.body.inputs.qpace_enable, "true");
  assert.equal(call.body.inputs.zram_default_algorithm, "qpace-lz4");
  assert.equal(call.body.inputs.zram_size_gib, "16");
  assert.equal(call.body.inputs.self_config, "false");
  assert.equal(call.body.inputs.hmbird_cpuperf_fix, undefined);
  assertPrivateMessages(state);
});

test("AOSP test entry is visible only to administrators or explicitly granted users", async t => {
  const { env, state } = await fixture(t, { workflowBinding: null });
  const menu = async () => {
    await worker.handleCommand(env, { message: { from: query.from, chat: query.message.chat } }, "build", []);
    return state.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  };
  assert.ok(!(await menu()).some(button => button.callback_data === "kernel:669aosp-test"));
  state.botState.set("workflow_access:669aosp-test:42", "1");
  assert.ok((await menu()).some(button => button.callback_data === "kernel:669aosp-test"));
  state.botState.clear();
  env.ADMIN_USER_IDS = "42";
  assert.ok((await menu()).some(button => button.callback_data === "kernel:669aosp-test"));
});

test("stale and forged AOSP test callbacks cannot bypass its access gate", async t => {
  const { env, state } = await fixture(t, { workflowBinding: "669aosp-test" });
  state.sessions.set(42, JSON.stringify({ serial, selectedScript: "669aosp-test", workflow: "669aosp-test", options: {} }));
  for (const data of ["kernel:669aosp-test", "bind:669aosp-test", "variant:669aosp-test:gki", "dispatch"])
    await worker.handleCallback(env, { callback_query: { ...query, id: data, data } });
  await worker.dispatchBuild(env, query, { serial, workflow: "669aosp-test", options: {} });
  assert.equal(dispatches(state).length, 0);
  assert.ok(state.calls.filter(call => call.body?.text?.includes("尚未向你开放")).length >= 5);
});

test("authorized AOSP test dispatch requires binding and selects the fixed test branch", async t => {
  const { env, state } = await fixture(t, { workflowBinding: null });
  state.botState.set("workflow_access:669aosp-test:42", "1");
  const draft = { serial, workflow: "669aosp-test", options: { ...worker.normalizeBuildOptions({}, false), qpace_enable: "true", zram_size_gib: "16", hmbird_cpuperf_fix: "true" } };
  await worker.dispatchBuild(env, query, draft);
  assert.equal(dispatches(state).length, 0);
  const click = data => worker.handleCallback(env, { callback_query: { ...query, id: data, data } });
  state.sessions.set(42, JSON.stringify({ serial, options: {} }));
  await click("kernel:669aosp-test");
  await click("bind:669aosp-test");
  await click("variant:669aosp-test:gki");
  const buttons = state.calls.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.callback_data === "set:qpace_enable:true"));
  assert.ok(buttons.some(button => button.callback_data === "set:hmbird_cpuperf_fix:true"));
  await worker.dispatchBuild(env, query, draft);
  const [call] = dispatches(state);
  assert.equal(call.body.ref, "test/aosp-hmbird-oneplus15-20261020");
  assert.equal(call.body.inputs.qpace_enable, "true");
  assert.equal(call.body.inputs.zram_size_gib, "16");
  assert.equal(call.body.inputs.hmbird_cpuperf_fix, "true");
  assert.equal(call.body.inputs.ccache_update, undefined);
  assert.equal(call.body.inputs.ccache_debug, undefined);
  assert.equal(call.body.inputs.github_ref, undefined);
  assert.equal(JSON.parse(state.jobs[0].inputs).github_ref, call.body.ref);
  assert.equal(state.workflowBinding, "669aosp-test");
  assertPrivateMessages(state);
});

test("AOSP grant unbinds only the intended user and preserves identity, preferences and jobs", async t => {
  const { env, database, timestamp, addJob } = await quotaFixture(t);
  addJob({ status: "running" });
  database.prepare("INSERT INTO user_build_preferences VALUES(?,?,?)").run(42, '{"qpace_enable":"true"}', timestamp);
  database.prepare("INSERT INTO sessions VALUES(?,?,?)").run(42, '{"workflow":"623g"}', timestamp);
  database.prepare("INSERT INTO workflow_bindings VALUES(?,?,?)").run(99, "669aosp", timestamp);
  const update = { message: { from: { id: 1 }, chat: { id: 1, type: "private" } } };
  await worker.handleCommand(env, update, "aosptest", [serial]);
  assert.equal(database.prepare("SELECT value FROM bot_state WHERE key=?").get("workflow_access:669aosp-test:42").value, "1");
  assert.equal(database.prepare("SELECT * FROM workflow_bindings WHERE telegram_user_id=42").get(), undefined);
  assert.equal(database.prepare("SELECT * FROM sessions WHERE telegram_user_id=42").get(), undefined);
  assert.equal(database.prepare("SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=99").get().workflow_key, "669aosp");
  assert.equal(database.prepare("SELECT owner_user_id FROM serial_bindings").get().owner_user_id, 42);
  assert.equal(database.prepare("SELECT options FROM user_build_preferences WHERE telegram_user_id=42").get().options, '{"qpace_enable":"true"}');
  assert.equal(database.prepare("SELECT status FROM build_jobs").get().status, "running");
  await worker.handleCommand(env, update, "aosptest", ["99"]);
  assert.equal(database.prepare("SELECT value FROM bot_state WHERE key=?").get("workflow_access:669aosp-test:99").value, "1");
});

test("test access revocation invalidates test binding and stale drafts without changing regular bindings", async t => {
  const { env, state, database, timestamp } = await quotaFixture(t);
  const update = { message: { from: { id: 1 }, chat: { id: 1, type: "private" } } };
  await worker.handleCommand(env, update, "aosptest", ["42"]);
  database.prepare("INSERT INTO workflow_bindings VALUES(?,?,?)").run(42, "669aosp-test", timestamp);
  database.prepare("INSERT INTO sessions VALUES(?,?,?)").run(42, '{"workflow":"669aosp-test"}', timestamp);
  await worker.handleCommand(env, update, "aosptest", ["42", "off"]);
  assert.equal(database.prepare("SELECT * FROM workflow_bindings WHERE telegram_user_id=42").get(), undefined);
  assert.equal(database.prepare("SELECT * FROM sessions WHERE telegram_user_id=42").get(), undefined);
  await worker.dispatchBuild(env, query, { serial, workflow: "669aosp-test", options: {} });
  assert.equal(dispatches(state).length, 0);
  database.prepare("INSERT INTO workflow_bindings VALUES(?,?,?)").run(42, "623", timestamp);
  await worker.handleCommand(env, update, "aosptest", ["42", "off"]);
  assert.equal(database.prepare("SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=42").get().workflow_key, "623");
});

test("script unbinding supports a serial or all users without resetting grants, quotas or current jobs", async t => {
  const { env, database, timestamp, addJob, countFailures } = await quotaFixture(t);
  addJob({ status: "running" });
  countFailures();
  database.prepare("INSERT INTO workflow_bindings VALUES(?,?,?)").run(99, "669aosp", timestamp);
  database.prepare("INSERT INTO sessions VALUES(?,?,?)").run(42, '{"workflow":"623g"}', timestamp);
  database.prepare("INSERT INTO sessions VALUES(?,?,?)").run(99, '{"workflow":"669aosp"}', timestamp);
  database.prepare("INSERT INTO sessions VALUES(?,?,?)").run(100, '{"awaitingJoinSerial":true}', timestamp);
  const update = { message: { from: { id: 1 }, chat: { id: 1, type: "private" } } };
  await worker.handleCommand(env, update, "unbindscript", [serial]);
  assert.equal(database.prepare("SELECT * FROM workflow_bindings WHERE telegram_user_id=42").get(), undefined);
  assert.ok(database.prepare("SELECT * FROM workflow_bindings WHERE telegram_user_id=99").get());
  await worker.handleCommand(env, update, "unbindscript", ["all"]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM workflow_bindings").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM serial_bindings").get().count, 1);
  assert.equal(database.prepare("SELECT status FROM build_jobs").get().status, "running");
  assert.ok(database.prepare("SELECT * FROM sessions WHERE telegram_user_id=100").get());
  assert.equal(database.prepare("SELECT value FROM bot_state WHERE key='quota_count_failures:42'").get().value, "1");
});

test("non-admins cannot grant test access or unbind scripts", async t => {
  const { env, database } = await quotaFixture(t);
  for (const [command, args] of [["aosptest", ["42"]], ["unbindscript", ["all"]]])
    await worker.handleCommand(env, { message: { from: query.from, chat: query.message.chat } }, command, args);
  assert.equal(database.prepare("SELECT workflow_key FROM workflow_bindings WHERE telegram_user_id=42").get().workflow_key, "623");
  assert.equal(database.prepare("SELECT * FROM bot_state WHERE key=?").get("workflow_access:669aosp-test:42"), undefined);
});

test("device-specific builds do not receive AOSP-only workflow inputs", async t => {
  const { env, state } = await fixture(t);
  const selected = kernelSession();
  Object.assign(selected.options, { zram_writeback_enable: "true", qpace_enable: "true", zram_default_algorithm: "qpace", zram_size_gib: "16", hmbird_cpuperf_fix: "true", ccache_update: "false", ccache_debug: "false" });
  await worker.dispatchBuild(env, query, selected);
  const [call] = dispatches(state);
  assert.equal(call.body.inputs.zram_writeback_enable, undefined);
  assert.equal(call.body.inputs.qpace_enable, undefined);
  assert.equal(call.body.inputs.zram_default_algorithm, undefined);
  assert.equal(call.body.inputs.zram_size_gib, undefined);
  assert.equal(call.body.inputs.hmbird_cpuperf_fix, undefined);
  assert.equal(call.body.inputs.ccache_update, "false");
  assert.equal(call.body.inputs.ccache_debug, "false");
});

test("ZRAM preferences retain only supported compressor and size choices", () => {
  for (const algorithm of ["default", "qpace-lz4", "qpace", "lz4kd"])
    assert.equal(worker.normalizeBuildOptions({ zram_default_algorithm: algorithm }, false).zram_default_algorithm, algorithm);
  assert.equal(worker.normalizeBuildOptions({ zram_default_algorithm: "invalid" }, false).zram_default_algorithm, "default");
  for (const size of ["default", "4", "6", "8", "10", "12", "16", "24", "32"])
    assert.equal(worker.normalizeBuildOptions({ zram_size_gib: size }, false).zram_size_gib, size);
  for (const size of ["invalid", "0", "-1", "16G", 16, "999"])
    assert.equal(worker.normalizeBuildOptions({ zram_size_gib: size }, false).zram_size_gib, "default");
  assert.equal(worker.normalizeBuildOptions({}, false).zram_size_gib, "default");
});

test("BakaSU is the default kernel manager and old ReSukiSU preferences migrate", () => {
  assert.equal(worker.normalizeBuildOptions({}, true).ksu_type, "bakasu");
  assert.equal(worker.normalizeBuildOptions({ ksu_type: "resukisu" }, true).ksu_type, "bakasu");
});

test("concurrent kernel clicks reserve one active slot before dispatch", async t => {
  const { env, state } = await fixture(t);
  await Promise.all([worker.dispatchBuild(env, query, kernelSession()), worker.dispatchBuild(env, query, kernelSession())]);
  assert.equal(dispatches(state).length, 1);
  assert.equal(state.jobs.length, 1);
});

test("kernel and LKM share the same concurrent active slot", async t => {
  const { env, state } = await fixture(t);
  await Promise.all([worker.dispatchBuild(env, query, kernelSession()), worker.dispatchNoMountBuild(env, query, session(), requestId)]);
  assert.equal(dispatches(state).length, 1);
  assert.equal(state.jobs.length, 1);
});

test("admins can submit concurrent kernel and LKM jobs without consuming the regular-user slot", async t => {
  const { env, state } = await fixture(t, { count: 99, latest: Math.floor(Date.now() / 1000) });
  env.ADMIN_USER_IDS = "42";
  await Promise.all([worker.dispatchBuild(env, query, kernelSession()), worker.dispatchNoMountBuild(env, query, session(), requestId)]);
  assert.equal(dispatches(state).length, 2);
  assert.equal(state.jobs.length, 2);
  assert.ok(state.jobs.every(job => job.active_user_id === null));
});

test("admin kernel requests are parallel across menus but duplicate confirmations are idempotent", async t => {
  const { env, state } = await fixture(t);
  env.ADMIN_USER_IDS = "42";
  const other = { ...query, message: { ...query.message, message_id: 8 } };
  await Promise.all([
    worker.dispatchBuild(env, query, kernelSession()),
    worker.dispatchBuild(env, query, kernelSession()),
    worker.dispatchBuild(env, other, kernelSession()),
  ]);
  assert.equal(dispatches(state).length, 2);
  assert.equal(new Set(state.jobs.map(job => job.request_id)).size, 2);
  assert.ok(state.jobs.every(job => job.active_user_id === null));
});

test("a finishing submission does not erase a newer administrator draft", async t => {
  const { env, state } = await fixture(t);
  env.ADMIN_USER_IDS = "42";
  const next = JSON.stringify({ serial, workflow: "669aosp-test", options: { qpace_enable: "true" } });
  state.sessions.set(42, next);
  await worker.dispatchBuild(env, query, kernelSession());
  assert.equal(state.sessions.get(42), next);
});

test("old administrator menus cannot submit a newer draft's workflow or options", async t => {
  const { env, state, database } = await quotaFixture(t);
  env.ADMIN_USER_IDS = "42";
  const update = { message: { from: query.from, chat: query.message.chat } };
  await worker.handleCommand(env, update, "build", []);
  let draft = JSON.parse(database.prepare("SELECT data FROM sessions WHERE telegram_user_id=42").get().data);
  assert.equal(draft.menuMessageId, 8);
  const originalToken = draft.menuToken;
  state.messageId = 9;
  await worker.handleCommand(env, update, "build", []);
  draft = JSON.parse(database.prepare("SELECT data FROM sessions WHERE telegram_user_id=42").get().data);
  assert.notEqual(draft.menuToken, originalToken);
  assert.equal(draft.menuMessageId, 9);
  await worker.handleCallback(env, { callback_query: { ...query, id: "old-menu", data: "dispatch", message: { ...query.message, message_id: 8 } } });
  assert.equal(dispatches(state).length, 0);
  assert.match(state.calls.at(-1).body.text, /菜单已失效/);
});

test("quick options atomically enforce both the test grant and the originating menu", async t => {
  const { env, state, database, timestamp } = await quotaFixture(t);
  for (const key of ["qpace_enable", "hmbird_cpuperf_fix"]) {
    database.prepare("INSERT OR REPLACE INTO bot_state VALUES(?,?)").run("workflow_access:669aosp-test:42", "1");
    const draft = { serial, workflow: "669aosp-test", options: { [key]: "false" }, menuMessageId: 9, menuChatId: 42 };
    database.prepare("INSERT OR REPLACE INTO sessions VALUES(?,?,?)").run(42, JSON.stringify(draft), timestamp);
    const click = messageId => worker.handleCallback(env, { callback_query: { ...query, id: "option", data: `set:${key}:true`,
      message: { ...query.message, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: key, callback_data: `set:${key}:true` }]] } } } });
    const value = () => JSON.parse(database.prepare("SELECT data FROM sessions WHERE telegram_user_id=42").get().data).options[key];
    await click(8);
    assert.equal(value(), "false");
    await click(9);
    assert.equal(value(), "true");
    database.prepare("UPDATE sessions SET data=? WHERE telegram_user_id=42").run(JSON.stringify(draft));
    database.prepare("UPDATE bot_state SET value='0' WHERE key=?").run("workflow_access:669aosp-test:42");
    await click(9);
    assert.equal(value(), "false");
    if (key === "hmbird_cpuperf_fix") {
      database.prepare("UPDATE sessions SET data=? WHERE telegram_user_id=42").run(JSON.stringify({ ...draft, workflow: "669aosp" }));
      await click(9);
      assert.equal(value(), "false");
    }
  }
  assert.equal(dispatches(state).length, 0);
});

test("test jobs cannot associate a same-title run from the regular branch", async t => {
  const { env, state, database, timestamp } = await quotaFixture(t);
  const ref = "test/aosp-hmbird-oneplus15-20261020";
  const inputs = JSON.stringify({ build_kind: "kernel", github_repo: env.GITHUB_REPO, github_ref: ref });
  database.prepare("INSERT INTO build_jobs(request_id,telegram_user_id,chat_id,workflow_file,inputs,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(requestId, 42, 42, "build_aosp_6.12.69_gki.yml", inputs, "submitted", timestamp, timestamp);
  state.githubResponse = async () => Response.json({ workflow_runs: [
    { id: 99, display_title: requestId, head_branch: "main", status: "in_progress" },
    { id: 100, display_title: requestId, head_branch: ref, status: "in_progress" },
  ] });
  await worker.processJob(env, database.prepare("SELECT * FROM build_jobs WHERE request_id=?").get(requestId));
  assert.equal(database.prepare("SELECT github_run_id FROM build_jobs WHERE request_id=?").get(requestId).github_run_id, 100);
});

for (const kind of ["kernel", "lkm"]) {
  test(`regular user cannot make a third daily ${kind} build`, async t => {
    const { env, state } = await fixture(t, { count: 2 });
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 0);
    assert.equal(state.jobs.length, 0);
    assert.ok(state.calls.some(call => call.body?.text?.includes("2 次构建上限")));
  });

  test(`regular user can make a second daily ${kind} build`, async t => {
    const { env, state } = await fixture(t, { count: 1 });
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 1);
  });

  test(`admin is exempt from daily ${kind} quota and cooldown`, async t => {
    const { env, state } = await fixture(t, { count: 99, latest: Math.floor(Date.now() / 1000) });
    env.ADMIN_USER_IDS = "42";
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 1);
  });

  test(`admin exemption does not bypass ${kind} authorization`, async t => {
    const { env, state } = await fixture(t, { count: 99, enabled: false });
    env.ADMIN_USER_IDS = "42";
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 0);
  });
}

test("default limit is two and obsolete bonus does not grant extra builds", async t => {
  const { env } = await fixture(t, { count: 2 });
  delete env.DAILY_BUILD_LIMIT;
  env.DAILY_BUILD_BONUS_DATE = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  env.DAILY_BUILD_BONUS = "99";
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
});

test("quota rolls at Beijing midnight, not UTC midnight", () => {
  const before = Date.parse("2026-10-01T15:59:59Z") / 1000;
  const after = before + 1;
  assert.deepEqual(worker.beijingDayBounds(before), [Date.parse("2026-09-30T16:00:00Z") / 1000, after]);
  assert.deepEqual(worker.beijingDayBounds(after), [after, after + 86400]);
});

test("without a per-user policy failures remain free", async t => {
  const { env, timestamp, addJob } = await quotaFixture(t);
  addJob();
  addJob();
  addJob({ status: "sent", succeededAt: timestamp - 1200 });
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
});

test("enabling the policy counts existing failures without rewriting build history", async t => {
  const { env, database, addJob, countFailures } = await quotaFixture(t);
  addJob();
  addJob();
  const before = database.prepare("SELECT * FROM build_jobs ORDER BY request_id").all();
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  countFailures();
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
  assert.deepEqual(database.prepare("SELECT * FROM build_jobs ORDER BY request_id").all(), before);
});

test("failure policy counts one success plus one failed run and only affects its user", async t => {
  const { env, timestamp, addJob, countFailures } = await quotaFixture(t);
  countFailures();
  for (const userId of [42, 43]) {
    addJob({ userId, status: "sent", succeededAt: timestamp - 1200 });
    addJob({ userId });
  }
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
  assert.equal(await worker.buildQuotaMessage(env, 43), null);
  countFailures(42, false);
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
});

for (const kind of ["kernel", "lkm"]) {
  test(`two failed runs block another ${kind} build for the selected user`, async t => {
    const { env, state, addJob, countFailures } = await quotaFixture(t);
    countFailures();
    addJob({ kind: "kernel" });
    addJob({ kind: "nomount-lkm" });
    if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
    else await worker.dispatchNoMountBuild(env, query, session(), requestId);
    assert.equal(dispatches(state).length, 0);
    assert.match(state.calls.at(-1).body.text, /2 次构建上限/);
    assertPrivateMessages(state);
  });
}

test("failure policy excludes rejected requests, unfinished runs and moved jobs", async t => {
  const { env, timestamp, addJob, countFailures } = await quotaFixture(t);
  countFailures();
  addJob({ runId: null });
  addJob({ runId: null });
  addJob({ status: "running" });
  addJob({ status: "submitted", runId: null });
  addJob({ status: "repository_moved" });
  addJob({ status: "sent", succeededAt: timestamp - 1200 });
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  addJob();
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
});

test("failed runs do not introduce a new cooldown or count a successful job twice", async t => {
  const { env, timestamp, addJob, countFailures } = await quotaFixture(t);
  countFailures();
  addJob({ status: "failed", succeededAt: timestamp - 1200 });
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  addJob({ createdAt: timestamp });
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
});

test("failure policy preserves quota resets and Beijing date boundaries", async t => {
  const { env, database, timestamp, addJob, countFailures } = await quotaFixture(t);
  countFailures();
  const [start, end] = worker.beijingDayBounds(timestamp);
  addJob({ createdAt: start - 1 });
  addJob({ createdAt: end });
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  addJob({ createdAt: timestamp - 5 });
  addJob({ createdAt: timestamp - 4 });
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
  database.prepare("INSERT INTO quota_resets(telegram_user_id,reset_at) VALUES(?,?)").run(42, timestamp - 4);
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  addJob({ createdAt: timestamp - 3 });
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
  addJob({ createdAt: timestamp - 2 });
  assert.match(await worker.buildQuotaMessage(env, 42), /2 次构建上限/);
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM build_jobs").get().total, 6);
});

test("admins remain exempt even with a failure policy", async t => {
  const { env, addJob, countFailures } = await quotaFixture(t);
  countFailures();
  addJob();
  addJob();
  env.ADMIN_USER_IDS = "42";
  assert.equal(await worker.buildQuotaMessage(env, 42), null);
});

test("rejected kernel dispatch does not charge the quota or block a fresh-menu retry", async t => {
  const { env, state } = await fixture(t, { dispatchStatus: 403 });
  await worker.dispatchBuild(env, { ...query, message: { ...query.message, message_id: 8 } }, kernelSession());
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].active_user_id, null);
  assert.equal(state.count, 0);
  state.dispatchStatus = 204;
  await worker.dispatchBuild(env, query, kernelSession());
  assert.equal(dispatches(state).length, 2);
  assert.equal(state.jobs[1].status, "submitted");
});

test("kernel never falls back to old or LKM credentials", async t => {
  const { env, state } = await fixture(t);
  delete env.KERNEL_GITHUB_TOKEN;
  assert.throws(() => worker.ghHeaders(env));
  await worker.dispatchBuild(env, query, kernelSession());
  assert.equal(dispatches(state).length, 0);
  assert.equal(state.jobs.length, 0);
});

test("kernel monitoring uses the repository recorded with the job", async t => {
  const { env, state } = await fixture(t);
  env.GITHUB_REPO = "zaud77/k6r9m2p7v4x8";
  const job = { request_id: requestId, chat_id: 42, workflow_file: "kernel.yml", github_run_id: 99,
    inputs: JSON.stringify({ build_kind: "kernel", github_repo: "zaominn/t8x3p6r9m2k7" }) };
  state.githubResponse = async url => {
    assert.equal(url, "https://api.github.com/repos/zaominn/t8x3p6r9m2k7/actions/runs/99");
    return Response.json({ status: "in_progress" });
  };
  await worker.processJob(env, job);
  assert.ok(state.calls.filter(call => call.url.includes("api.github.com")).every(call => call.options.headers.authorization === "Bearer new-kernel-fixture-token"));
});

test("production configuration uses zaud77 repositories and one shared quota", async () => {
  const config = JSON.parse(await readFile(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.vars.GITHUB_REPO, "zaud77/k6r9m2p7v4x8");
  assert.equal(config.vars.DAILY_BUILD_LIMIT, "2");
  assert.equal(config.vars.DAILY_BUILD_BONUS, undefined);
  assert.equal(config.vars.LKM_GITHUB_REPO, "zaud77/m8v3p6r9x2k4");
});

test("health reports deployed repository bindings without exposing credentials", async t => {
  const { env, state } = await fixture(t);
  const response = await worker.default.fetch(new Request("https://fixture.invalid/health"), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.kernelRepository, "zaud77/k6r9m2p7v4x8");
  assert.equal(body.nomountRepository, "zaud77/m8v3p6r9x2k4");
  assert.equal(body.kernelBuildsReady, true);
  assert.equal(body.nomountBuildsReady, true);
  assert.equal(body.privateBuildsReady, false);
  assert.deepEqual(body.nomountKernelSeries, ["6.12", "6.18"]);
  assert.equal(body.dailyBuildLimit, 2);
  assert.equal(body.quotaIncludesAdmins, false);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.stringify(body).includes("fixture-token"), false);
  const deploy = await readFile(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  const revision = source.match(/const COMMAND_MENU_REVISION = "([^"]+)";/)[1];
  assert.ok(deploy.includes(`and .commandMenus == "${revision}"`));
  assert.ok(deploy.includes('and .nomountKernelSeries == ["6.12", "6.18"]'));
  Object.assign(env, { PRIVATE_BUILD_TOKEN: "private-fixture-token", PRIVATE_KERNEL_REPOSITORY: "private/kernel", PRIVATE_LKM_REPOSITORY: "private/lkm" });
  const configured = await (await worker.default.fetch(new Request("https://fixture.invalid/health"), env, {})).json();
  assert.equal(configured.privateBuildsReady, true);
  assert.equal(JSON.stringify(configured).includes("private/"), false);
  assert.equal(JSON.stringify(configured).includes("private-fixture-token"), false);
});
