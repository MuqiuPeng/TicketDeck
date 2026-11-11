import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store, parseTicket, projectRoot, serializeTicket, normalizeId } from "../dist/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const mcp = path.join(here, "..", "dist", "mcp.js");

function tmpProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-")));
  process.env.TICKETDECK_HOME = path.join(dir, ".home");
  const s = new Store(dir);
  s.init();
  return s;
}

test("create, read back, update, claim and log", () => {
  const s = tmpProject();
  const r = s.create({ title: "Login redirect loops forever", body: "## Context\nfound it\n", type: "bug", priority: "P1", files: ["src/auth.ts"] }, "local_abcdef1234567890");
  const t = r.ticket;
  assert.equal(t.id, "T-0001");
  assert.ok(t.path.endsWith("T-0001-login-redirect-loops-forever.md"));

  const back = s.get("1");
  assert.equal(back.title, t.title);
  assert.equal(back.priority, "P1");
  assert.deepEqual(back.files, ["src/auth.ts"]);
  assert.match(back.body, /## 日志\n- .* · local_abcdef12 · 创建/);

  s.claim("T-0001", "local_xyz", "local_xyz");
  const u = s.update("T-1", { status: "review", note: "fixed middleware order" }, "local_xyz");
  assert.equal(u.status, "review");
  assert.equal(u.session, "local_xyz");
  s.log("T-0001", "added e2e", "user");
  const log = fs.readFileSync(u.path, "utf8");
  assert.match(log, /状态 → 进行中, 认领会话 → local_xyz — 认领/);
  assert.match(log, /状态 → 待验收 — fixed middleware order/);
  assert.match(log, /user · added e2e\n$/);
  assert.equal((log.match(/## 日志/g) ?? []).length, 1);
});

test("title change renames the file", () => {
  const s = tmpProject();
  const t = s.create({ title: "old name" }, "user").ticket;
  const u = s.update(t.id, { title: "new name" }, "user");
  assert.ok(u.path.endsWith("T-0001-new-name.md"));
  assert.ok(!fs.existsSync(t.path));
  assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith(".md")).length, 1);
});

test("duplicate detection, English and Chinese", () => {
  const s = tmpProject();
  s.create({ title: "Login redirect loops forever" }, "user");
  s.create({ title: "登录后重定向死循环" }, "user");
  assert.ok(s.create({ title: "login redirect loops" }, "user").duplicates?.length);
  assert.ok(s.create({ title: "登录重定向死循环" }, "user").duplicates?.length);
  assert.ok(s.create({ title: "Add dark mode" }, "user").ticket);
  assert.ok(s.create({ title: "login redirect loops", force: true }, "user").ticket);
  // Closed tickets don't count as duplicates.
  s.update("T-0001", { status: "dropped" }, "user");
  s.update("T-0004", { status: "dropped" }, "user");
  assert.ok(s.create({ title: "Login redirect loops forever" }, "user").ticket);
});

test("list filters and ordering", () => {
  const s = tmpProject();
  s.create({ title: "a", priority: "P3" }, "user");
  s.create({ title: "b", priority: "P0" }, "user");
  s.create({ title: "c" }, "user");
  s.update("3", { status: "doing" }, "user");
  s.update("1", { status: "done" }, "user");
  assert.deepEqual(s.list().map((t) => t.id), ["T-0003", "T-0002"]);
  assert.equal(s.list({ includeClosed: true }).length, 3);
  assert.deepEqual(s.list({ status: ["done"] }).map((t) => t.id), ["T-0001"]);
});

test("old closed tickets are archived and ids keep counting", () => {
  const s = tmpProject();
  const t = s.create({ title: "old" }, "user").ticket;
  s.update(t.id, { status: "done" }, "user");
  const text = fs.readFileSync(s.get(t.id).path, "utf8").replace(/^updated: .*$/m, "updated: 2020-01-01T00:00+00:00");
  fs.writeFileSync(s.get(t.id).path, text);
  s.list();
  assert.ok(fs.existsSync(path.join(s.dir, "archive", path.basename(t.path))));
  assert.equal(s.get(t.id).archived, true);
  assert.equal(s.create({ title: "next" }, "user").ticket.id, "T-0002");
});

test("frontmatter round-trips awkward values", () => {
  const t = {
    id: "T-0009", title: 'colon: "quotes" # hash', status: "todo", priority: "P2", type: "idea",
    labels: ["a b", "c,d"], created: "2026-11-09T10:00+08:00", updated: "2026-11-09T10:00+08:00",
    created_by: "user", session: null, depends_on: ["T-0001"], files: [], body: "hello\n", path: "/x/T-0009.md", archived: false,
  };
  const back = parseTicket(serializeTicket(t), t.path);
  assert.deepEqual({ ...back }, { ...t });
});

test("depends_on must name existing tickets", () => {
  const s = tmpProject();
  s.create({ title: "first" }, "user");
  assert.throws(() => s.create({ title: "second", depends_on: ["9"] }, "user"), /no such ticket T-0009/);
  assert.equal(s.create({ title: "second", depends_on: ["1"] }, "user").ticket.depends_on[0], "T-0001");
  assert.throws(() => s.update("1", { depends_on: ["1"] }, "user"), /no such ticket T-0001/);
});

test("normalizeId", () => {
  assert.equal(normalizeId("7"), "T-0007");
  assert.equal(normalizeId("t-12"), "T-0012");
  assert.equal(normalizeId("T-0012"), "T-0012");
});

test("concurrent creators never share an id", async () => {
  const s = tmpProject();
  const procs = Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [cli, "new", `parallel ticket number ${i} ${"xyzw"[i % 4]}${i}`, "--force"], { cwd: s.root, env: process.env });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    }),
  );
  await Promise.all(procs);
  const ids = s.all().map((t) => t.id);
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
});

test("worktrees share the main checkout's tickets", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-git-")));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  new Store(dir).init();
  git("worktree", "add", "-q", path.join(dir, "wt"), "-b", "wt");
  fs.mkdirSync(path.join(dir, "wt", "sub"));
  delete process.env.TICKETDECK_ROOT;
  assert.equal(projectRoot(path.join(dir, "wt", "sub")), dir);
  assert.equal(projectRoot(path.join(dir)), dir);
});

test("CLI: init writes rules and .mcp.json idempotently", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-cli-")));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\n\nExisting notes.\n");
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { cwd: dir, env: process.env }).toString();
  run("init", "--mcp");
  run("init", "--mcp");
  const md = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(md.startsWith("# Project\n\nExisting notes.\n\n<!-- ticketdeck:start -->"));
  assert.equal((md.match(/ticketdeck:start/g) ?? []).length, 1);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
  assert.ok(cfg.mcpServers.other);
  assert.equal(cfg.mcpServers.ticketdeck.args[0], mcp);
  assert.match(run("new", "Write docs", "-p", "p1"), /Created T-0001/);
  assert.match(run("list"), /T-0001 \[todo\] P1 feature — Write docs/);
  assert.match(run("set", "1", "status=doing", "labels=docs,web"), /\[doing\].*#docs #web/);
  assert.match(run("done", "1"), /\[done\]/);
  assert.match(run("list"), /No open tickets/);
});

test("old English logs still parse and get appended to", () => {
  const s = tmpProject();
  const file = path.join(s.dir, "T-0001-old.md");
  fs.writeFileSync(file, "---\nid: T-0001\ntitle: old\nstatus: todo\npriority: P2\ntype: chore\nlabels: []\ncreated: 2026-11-01T10:00+11:00\nupdated: 2026-11-01T10:00+11:00\ncreated_by: user\nsession:\ndepends_on: []\nfiles: []\n---\n\nctx\n\n## Log\n- 2026-11-01 10:00 · user · created\n");
  s.update("1", { status: "done" }, "user");
  const text = fs.readFileSync(s.get("1").path, "utf8");
  assert.equal((text.match(/^## (Log|日志)$/gm) ?? []).length, 1, "no second log heading");
  assert.match(text, /## Log\n- .*created\n- .*状态 → 已完成/);
});
