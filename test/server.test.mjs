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

test("daily report: sections, activity window, saved reports over the API", { timeout: 20000 }, async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-report-")));
  process.env.TICKETDECK_HOME = path.join(parent, ".home");
  const root = path.join(parent, "Proj");
  fs.mkdirSync(root);
  const store = new Store(root);
  store.init();
  store.create({ title: "Needs review", labels: [] }, "local_a");
  store.update("1", { status: "review" }, "local_a");
  store.create({ title: "Pick an approach", priority: "P1", labels: ["decision"] }, "local_a");
  fs.mkdirSync(process.env.TICKETDECK_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.TICKETDECK_HOME, "projects.json"), JSON.stringify({ projects: [{ path: root, lastUsed: new Date().toISOString() }] }));

  const { buildReport, saveReport, localDate } = await import("../dist/report.js");
  const md = buildReport(new Date());
  for (const h of ["# Daily report", "## Needs you", "## Last 24 hours", "## In progress", "## Top priorities", "## By project"]) assert.ok(md.includes(h), h);
  assert.match(md, /Ready for review \(1\)[\s\S]*\*\*Proj\*\* T-0001 Needs review/);
  assert.match(md, /Waiting on your decision or action \(1\)[\s\S]*P1 \*\*Proj\*\* T-0002/);
  assert.match(md, /\*\*Proj\*\* — 2 new, 1 updates/);
  assert.match(buildReport(new Date(Date.now() + 3 * 86_400_000)), /No ticket activity/);

  saveReport(md, localDate());
  const board = await serve({ port: 0 });
  t.after(() => board.close());
  const base = board.url.replace(/\/$/, "");
  assert.deepEqual((await (await fetch(`${base}/api/reports`)).json()).dates, [localDate()]);
  assert.match((await (await fetch(`${base}/api/report`)).json()).markdown, /# Daily report/);
  assert.equal((await fetch(`${base}/api/report?date=../../etc/passwd`)).status, 404);
});
