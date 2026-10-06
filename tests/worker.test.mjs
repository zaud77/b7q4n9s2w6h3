import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { zipSync, strToU8 } from "fflate";

const require = createRequire(import.meta.url);
const source = (await readFile(new URL("../worker/src/index.ts", import.meta.url), "utf8"))
  .replace('from "fflate"', `from ${JSON.stringify(pathToFileURL(require.resolve("fflate")).href)}`)
  + "\nexport { handleCommand, dispatchBuild, dispatchNoMountBuild, nomountInputs, validateNoMountPackage, processJob, ghHeaders, digestSerial, buildQuotaMessage, beijingDayBounds, unwrapArtifact, NOMOUNT_PACKAGE_RE, normalizeBuildOptions };";
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const worker = await import("data:text/javascript;base64," + Buffer.from(compiled.outputText).toString("base64"));
const requestId = "a123456789012345";
const serial = "TEST_DEVICE_123";
const query = { from: { id: 42 }, message: { chat: { id: 42, type: "private" }, message_id: 7 } };

async function fixture(t, overrides = {}) {
  const state = { bound: serial, enabled: true, member: true, count: 0, latest: null, sessions: new Map(), jobs: [], calls: [], dispatchStatus: 204, ...overrides };
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
        if (sql.includes("SELECT value FROM bot_state")) return { value: "done" };
        if (sql.includes("SELECT serial_value")) return state.bound ? { serial_value: state.bound } : null;
        if (sql.includes("SELECT workflow_key")) return { workflow_key: "623" };
        if (sql.includes("SELECT 1 AS yes FROM build_jobs")) return state.jobs.some(job => job.active_user_id === values[0]) ? { yes: 1 } : null;
        if (sql.includes("SELECT data FROM sessions")) return state.sessions.has(values[0]) ? { data: state.sessions.get(values[0]), updated_at: Math.floor(Date.now() / 1000) } : null;
        if (sql.includes("SELECT MAX(created_at)")) return { latest: state.latest };
        if (sql.includes("SELECT COUNT(*)")) return { total: state.count };
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO sessions")) state.sessions.set(values[0], values[1]);
        if (sql.includes("DELETE FROM sessions")) state.sessions.delete(values[0]);
        if (sql.includes("INSERT INTO build_jobs")) {
          if (state.jobs.some(job => job.active_user_id === values[2] || job.request_id === values[0])) throw new Error("unique job constraint");
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
      const result = String(url).endsWith("getChatMember") ? { status: state.member ? "member" : "left" } : { chat: { type: "private", id: 42 }, message_id: 8 };
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
  const { filename, digestOnly, packageOverride, conclusion = "success", ...overrides } = options;
  const { env, state } = await fixture(t, overrides);
  const inputs = await worker.nomountInputs(serial, requestId);
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
    if (url.endsWith("/artifacts")) return Response.json({ artifacts: [{ name: "nomount-suite-lkm", archive_download_url: "https://api.github.com/download/fixture" }] });
    if (url.endsWith("/download/fixture")) return new Response(outer);
    throw new Error("Unexpected fixture request");
  };
  return { env, state, job, payload, outer, name };
}

test("bound users get a private, serial-free confirmation", async t => {
  const { env, state } = await fixture(t);
  await worker.handleCommand(env, { message: { from: { id: 42 }, chat: { id: 42, type: "private" } } }, "nomount", []);
  const saved = JSON.parse(state.sessions.get(42));
  assert.equal(saved.serial, serial);
  assert.match(saved.nomountRequestId, /^[a-f0-9]{16}$/);
  assert.equal(dispatches(state).length, 0);
  const prompt = state.calls.find(call => call.body?.text?.includes("NoMount LKM")).body.text;
  assert.equal(prompt, "构建 NoMount LKM？");
  assert.ok(prompt.length < 50);
  assert.equal(prompt.includes("\n"), false);
  assert.equal(prompt.includes(serial), false);
  assertPrivateMessages(state);
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
  assert.deepEqual(Object.keys(call.body.inputs).sort(), ["build_request_id", "device_serial", "device_serial_sha256"]);
  assert.equal(call.body.inputs.device_serial, serial);
  assert.equal(JSON.parse(state.jobs[0].inputs).device_serial, serial);
  assert.equal(state.jobs[0].chat_id, 42);
  assert.equal(state.calls.at(-1).body.text, "已提交，完成后自动发包。");
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
  assert.equal(sent.body.get("document").name, `NoMount-Suite-v1.80-LKM-${serial}.zip`);
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
  assert.equal(document.name, `NoMount-Suite-v1.80-LKM-${serial}.zip`);
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

test("admin quota exemption still permits only one concurrent active build", async t => {
  const { env, state } = await fixture(t, { count: 99, latest: Math.floor(Date.now() / 1000) });
  env.ADMIN_USER_IDS = "42";
  await Promise.all([worker.dispatchBuild(env, query, kernelSession()), worker.dispatchNoMountBuild(env, query, session(), requestId)]);
  assert.equal(dispatches(state).length, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].active_user_id, 42);
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

test("rejected kernel dispatch does not charge the quota or block a retry", async t => {
  const { env, state } = await fixture(t, { dispatchStatus: 403 });
  await worker.dispatchBuild(env, query, kernelSession());
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
  assert.equal(body.dailyBuildLimit, 2);
  assert.equal(body.quotaIncludesAdmins, false);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.stringify(body).includes("fixture-token"), false);
});
