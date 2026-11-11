import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Store } from "../dist/core.js";
import { serve } from "../dist/server.js";

test("board: state, updates, checklist, create, live events and request guards", { timeout: 20000 }, async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-board-")));
  process.env.TICKETDECK_HOME = path.join(parent, ".home");
  delete process.env.TICKETDECK_ROOT;
  const root = path.join(parent, "Proj");
  fs.mkdirSync(root);
  const store = new Store(root);
  store.init();
  store.create({ title: "Board ticket", body: "ctx\n\n- [ ] one\n- [ ] two" }, "user");
  fs.mkdirSync(process.env.TICKETDECK_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.TICKETDECK_HOME, "projects.json"), JSON.stringify({ projects: [{ path: root, lastUsed: new Date().toISOString() }] }));

  const board = await serve({ port: 0 });
  t.after(() => board.close());
  const base = board.url.replace(/\/$/, "");
  const post = (route, body, headers = {}) =>
    fetch(`${base}/api/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  for (const p of ["/", "/app.js", "/style.css", "/vendor/marked.js"]) assert.equal((await fetch(base + p)).status, 200, p);

  let state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.projects[0].name, "Proj");
  assert.equal(state.projects[0].tickets[0].id, "T-0001");

  // Live events: a change made outside the board (as an agent would) is announced.
  const ctrl = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = events.body.getReader();
  const seen = (async () => {
    let text = "";
    while (!text.includes("event: change")) text += new TextDecoder().decode((await reader.read()).value);
  })();
  await new Promise((r) => setTimeout(r, 100));
  store.log("1", "agent progress", "local_x");
  await seen;
  ctrl.abort();

  assert.equal((await (await post("check", { project: root, id: "T-0001", index: 1, checked: true })).json()).body.includes("- [x] two"), true);
  assert.equal((await (await post("update", { project: root, id: "1", status: "done" })).json()).status, "done");
  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.projects[0].tickets[0].status, "done", "done tickets stay on the board");

  const created = await (await post("create", { project: root, title: "From the board", body: "x", labels: ["web"] })).json();
  assert.equal(created.ticket.id, "T-0002");
  const dupe = await (await post("create", { project: root, title: "From the board" })).json();
  assert.equal(dupe.duplicates[0].id, "T-0002");

  // Guards: unknown project, non-JSON body, foreign origin, foreign Host.
  assert.equal((await post("update", { project: "/etc", id: "1", status: "todo" })).status, 400);
  assert.equal((await fetch(`${base}/api/update`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post("update", { project: root, id: "1" }, { origin: "https://evil.example" })).status, 403);
  const port = new URL(base).port;
  const http = await import("node:http");
  const status = await new Promise((resolve) =>
    http.get({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode)),
  );
  assert.equal(status, 403);
});

test("daily report: structure, activity window, annotate, API", { timeout: 20000 }, async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-report-")));
  process.env.TICKETDECK_HOME = path.join(parent, ".home");
  const root = path.join(parent, "Proj");
  fs.mkdirSync(root);
  const store = new Store(root);
  store.init();
  store.create({ title: "Needs review" }, "local_a");
  store.update("1", { status: "review" }, "local_a");
  store.create({ title: "Pick an approach", priority: "P1", labels: ["decision"] }, "local_a");
  store.create({ title: "Urgent fix", priority: "P0" }, "local_a");
  store.create({ title: "Shipped" }, "local_a");
  store.update("4", { status: "done" }, "user");
  fs.mkdirSync(process.env.TICKETDECK_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.TICKETDECK_HOME, "projects.json"), JSON.stringify({ projects: [{ path: root, lastUsed: new Date().toISOString() }] }));

  const { buildReport, saveReport, annotateReport, reportText } = await import("../dist/report.js");
  const r = buildReport(new Date());
  assert.deepEqual(r.review.map((i) => i.id), ["T-0001"]);
  assert.deepEqual(r.decisions.map((i) => i.id), ["T-0002"]);
  assert.deepEqual(r.priorities.map((i) => i.id), ["T-0003"], "decisions are not repeated as priorities");
  assert.deepEqual(r.activity, [{ project: "Proj", root, created: 4, done: 1, updated: 1 }]);
  assert.equal(r.totals.done, 1);
  assert.equal(buildReport(new Date(Date.now() + 3 * 86_400_000)).activity.length, 0);
  // 今日重点: review first, then decisions, then P0/P1 work.
  assert.deepEqual(r.focus.map((f) => [f.id, f.kind]), [["T-0001", "review"], ["T-0002", "decision"], ["T-0003", "push"]]);

  saveReport(r);
  const a = annotateReport(r.date, "两句话的总结。", [{ project: "Proj", task: "Commit the thing", session: "local_x" }], [{ project: "proj", id: "3", reason: "上线前必须修" }]);
  assert.equal(a.summary, "两句话的总结。");
  assert.deepEqual(a.focus.map((f) => [f.id, f.kind, f.reason]), [["T-0003", "push", "上线前必须修"]]);
  assert.match(reportText(a), /今日重点[\s\S]*优先推进[\s\S]*上线前必须修[\s\S]*待纳入计划[\s\S]*Commit the thing/);

  // 提议执行: written separately, checked, numbered; other annotations stay.
  assert.equal(a.proposals ?? null, null);
  const p = annotateReport(r.date, undefined, undefined, undefined, [
    { project: "proj", title: "关掉已完成的工单", why: "代码已合并", tickets: ["T-0001"], prompt: "核对 T-0001 是否已合并，是就关掉。" },
  ]);
  assert.deepEqual(p.proposals, [{ id: "p1", project: "Proj", root, title: "关掉已完成的工单", prompt: "核对 T-0001 是否已合并，是就关掉。", why: "代码已合并", tickets: ["T-0001"] }]);
  assert.equal(p.summary, "两句话的总结。");
  assert.match(reportText(p), /提议执行 · 1 项[\s\S]*p1 Proj 关掉已完成的工单/);
  assert.throws(() => annotateReport(r.date, undefined, undefined, undefined, [{ project: "Nope", title: "x", prompt: "y" }]), /no project/);
  assert.throws(() => annotateReport(r.date, undefined, undefined, undefined, [{ project: "Proj", title: "x" }]), /needs project, title and prompt/);
  assert.equal(annotateReport(r.date, undefined, undefined, undefined, []).proposals.length, 0);

  const board = await serve({ port: 0 });
  t.after(() => board.close());
  const base = board.url.replace(/\/$/, "");
  assert.deepEqual((await (await fetch(`${base}/api/reports`)).json()).dates, [r.date]);
  assert.equal((await (await fetch(`${base}/api/report`)).json()).summary, "两句话的总结。");
  assert.equal((await fetch(`${base}/api/report?date=../../etc/passwd`)).status, 404);

  // 提议执行: statuses survive a rewrite of the same proposal; the board sets them.
  const { setProposalStatus } = await import("../dist/report.js");
  annotateReport(r.date, undefined, undefined, undefined, [
    { project: "Proj", title: "关掉已完成的工单", prompt: "核对。" },
    { project: "Proj", title: "删除已合并分支", prompt: "删。" },
  ]);
  assert.equal(setProposalStatus(r.date, "p1", "dismissed").status, "dismissed");
  const again = annotateReport(r.date, undefined, undefined, undefined, [
    { project: "Proj", title: "删除已合并分支", prompt: "删。" },
    { project: "Proj", title: "关掉已完成的工单", prompt: "核对。" },
  ]);
  assert.deepEqual(again.proposals.map((p) => [p.id, p.status]), [["p1", undefined], ["p2", "dismissed"]]);
  const post = (route, body) => fetch(`${base}/api/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await (await post("proposal", { date: r.date, id: "p1", status: "started" })).json()).status, "started");
  assert.equal((await post("proposal", { date: r.date, id: "p9", status: "started" })).status, 400);
  assert.equal((await post("proposal", { date: r.date, id: "p1", status: "bogus" })).status, 400);
  const served = await (await fetch(`${base}/api/report`)).json();
  assert.deepEqual(served.proposals.map((p) => p.status ?? null), ["started", "dismissed"]);
  assert.equal(served.proposeJob, null);
});
