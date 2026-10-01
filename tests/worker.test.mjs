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
  + "\nexport { handleCommand, dispatchBuild, dispatchNoMountBuild, nomountInputs, validateNoMountPackage, processJob, ghHeaders, digestSerial, buildQuotaMessage, beijingDayBounds };";
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const worker = await import("data:text/javascript;base64," + Buffer.from(compiled.outputText).toString("base64"));
const requestId = "a123456789012345";
const serial = "TEST_DEVICE_123";
const query = { from: { id: 42 }, message: { chat: { id: 42, type: "private" }, message_id: 7 } };

async function fixture(t, overrides = {}) {
  const state = { bound: serial, enabled: true, member: true, count: 0, latest: null, sessions: new Map(), jobs: [], calls: [], dispatchStatus: 204, ...overrides };
  const env = { ADMIN_USER_IDS: "1", SERIAL_PEPPER: "fixture-pepper", GITHUB_TOKEN: "old-kernel-fixture-token",
    KERNEL_GITHUB_TOKEN: "new-kernel-fixture-token", LKM_GITHUB_TOKEN: "new-lkm-fixture-token",
    GITHUB_REPO: "zaominn/t8x3p6r9m2k7", LKM_GITHUB_REPO: "zaominn/nomount-lkm",
    LKM_GITHUB_REF: "main", GITHUB_REF: "main", TELEGRAM_BOT_TOKEN: "fixture", BUILD_COOLDOWN_SECONDS: "600", DAILY_BUILD_LIMIT: "1" };
  const hash = await worker.digestSerial(env, serial);
  env.SERIALS = { async get(key) { return key === `serial:${hash}` && state.enabled ? { serial, enabled: true } : null; } };
  env.DB = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() {
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
    if (String(url).endsWith("/dispatches")) return new Response(null, { status: state.dispatchStatus });
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

test("bound users get a private, serial-free confirmation", async t => {
  const { env, state } = await fixture(t);
  await worker.handleCommand(env, { message: { from: { id: 42 }, chat: { id: 42, type: "private" } } }, "nomount", []);
  const saved = JSON.parse(state.sessions.get(42));
  assert.equal(saved.serial, serial);
  assert.match(saved.nomountRequestId, /^[a-f0-9]{16}$/);
  assert.equal(dispatches(state).length, 0);
  assert.ok(state.calls.some(call => call.body?.text?.includes("NoMount Suite LKM")));
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

test("payload uses SHA256 and the dedicated repository credential", async t => {
  const { env, state } = await fixture(t);
  await worker.dispatchNoMountBuild(env, query, session(), requestId);
  const [call] = dispatches(state);
  assert.equal(call.url, "https://api.github.com/repos/zaominn/nomount-lkm/actions/workflows/lkm.yml/dispatches");
  assert.equal(call.options.headers.authorization, "Bearer new-lkm-fixture-token");
  assert.deepEqual(Object.keys(call.body.inputs).sort(), ["build_request_id", "device_serial_sha256"]);
  assert.equal(JSON.stringify(call.body).includes(serial), false);
  assert.equal(state.jobs[0].inputs.includes(serial), false);
  assert.equal(state.jobs[0].chat_id, 42);
});

test("concurrent repeat clicks cause only one dispatch", async t => {
  const { env, state } = await fixture(t);
  await Promise.all([worker.dispatchNoMountBuild(env, query, session(), requestId), worker.dispatchNoMountBuild(env, query, session(), requestId)]);
  assert.equal(dispatches(state).length, 1);
  assert.equal(state.jobs.length, 1);
});

for (const [name, overrides] of [["daily quota", { count: 1 }], ["cooldown", { latest: Math.floor(Date.now() / 1000) }]]) {
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
});

test("successful delivery sends the inner installable ZIP, not the artifact wrapper", async t => {
  const { env, state } = await fixture(t);
  const inputs = await worker.nomountInputs(serial, requestId);
  const payload = packageBytes(inputs.device_serial_sha256);
  const outer = zipSync({ "NoMount-Suite-v1.80-LKM.zip": payload });
  const job = { request_id: requestId, telegram_user_id: 42, chat_id: 42, workflow_file: "lkm.yml", github_run_id: 99,
    inputs: JSON.stringify({ ...inputs, build_kind: "nomount-lkm", github_repo: "zaominn/nomount-lkm" }) };
  state.jobs.push({ ...job, active_user_id: 42 });
  state.githubResponse = async url => {
    if (url.endsWith("/runs/99")) return Response.json({ status: "completed", conclusion: "success" });
    if (url.endsWith("/artifacts")) return Response.json({ artifacts: [{ name: "nomount-suite-lkm", archive_download_url: "https://api.github.com/download/fixture" }] });
    if (url.endsWith("/download/fixture")) return new Response(outer);
    throw new Error("Unexpected GitHub fixture request");
  };
  await worker.processJob(env, job);
  const sent = state.calls.find(call => call.url.endsWith("/sendDocument"));
  assert.equal(sent.body.get("document").name, "NoMount-Suite-v1.80-LKM.zip");
  assert.deepEqual(new Uint8Array(await sent.body.get("document").arrayBuffer()), payload);
  assert.equal(state.jobs[0].status, "sent");
  assert.ok(state.calls.filter(call => call.url.includes("api.github.com")).every(call => call.options.headers.authorization === "Bearer new-lkm-fixture-token"));
});

test("kernel dispatch uses the new private repository and credential", async t => {
  const { env, state } = await fixture(t);
  await worker.dispatchBuild(env, query, kernelSession());
  const [call] = dispatches(state);
  assert.equal(call.url, "https://api.github.com/repos/zaominn/t8x3p6r9m2k7/actions/workflows/fastbuild_6.12.23_oneplus_15_hmbird_gold.yml/dispatches");
  assert.equal(call.options.headers.authorization, "Bearer new-kernel-fixture-token");
  assert.equal(call.body.inputs.device_serial, serial);
  assert.equal(call.body.inputs.build_kind, undefined);
  assert.equal(call.body.inputs.github_repo, undefined);
  assert.equal(JSON.parse(state.jobs[0].inputs).github_repo, env.GITHUB_REPO);
  assert.equal(state.jobs[0].chat_id, 42);
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

for (const admin of [false, true]) {
  for (const kind of ["kernel", "lkm"]) {
    test(`${admin ? "admin" : "regular user"} cannot make a second daily ${kind} build`, async t => {
      const { env, state } = await fixture(t, { count: 1 });
      if (admin) env.ADMIN_USER_IDS = "42";
      if (kind === "kernel") await worker.dispatchBuild(env, query, kernelSession());
      else await worker.dispatchNoMountBuild(env, query, session(), requestId);
      assert.equal(dispatches(state).length, 0);
      assert.equal(state.jobs.length, 0);
      assert.ok(state.calls.some(call => call.body?.text?.includes("1 次构建上限")));
    });
  }
}

test("default limit is one and obsolete bonus does not grant extra builds", async t => {
  const { env } = await fixture(t, { count: 1 });
  delete env.DAILY_BUILD_LIMIT;
  env.DAILY_BUILD_BONUS_DATE = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  env.DAILY_BUILD_BONUS = "99";
  assert.match(await worker.buildQuotaMessage(env, 42), /1 次构建上限/);
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
  env.GITHUB_REPO = "zaominn/next-workspace";
  const job = { request_id: requestId, chat_id: 42, workflow_file: "kernel.yml", github_run_id: 99,
    inputs: JSON.stringify({ build_kind: "kernel", github_repo: "zaominn/t8x3p6r9m2k7" }) };
  state.githubResponse = async url => {
    assert.equal(url, "https://api.github.com/repos/zaominn/t8x3p6r9m2k7/actions/runs/99");
    return Response.json({ status: "in_progress" });
  };
  await worker.processJob(env, job);
  assert.ok(state.calls.filter(call => call.url.includes("api.github.com")).every(call => call.options.headers.authorization === "Bearer new-kernel-fixture-token"));
});

test("production configuration uses the private replacement and one shared quota", async () => {
  const config = JSON.parse(await readFile(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.vars.GITHUB_REPO, "zaominn/t8x3p6r9m2k7");
  assert.equal(config.vars.DAILY_BUILD_LIMIT, "1");
  assert.equal(config.vars.DAILY_BUILD_BONUS, undefined);
  assert.equal(config.vars.LKM_GITHUB_REPO, "zaominn/nomount-lkm");
});
