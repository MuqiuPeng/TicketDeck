import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { Store } from "../dist/core.js";

const mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");

async function connect(cwd, sessionId, home = path.join(cwd, ".home")) {
  const env = { ...process.env, TICKETDECK_HOME: home, CLAUDE_CODE_HOST_SESSION_ID: sessionId };
  delete env.TICKETDECK_ROOT;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp], cwd, env }));
  after(() => client.close());
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

test("MCP: an agent session works through the whole ticket lifecycle", { timeout: 20000 }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-mcp-")));

  // Not initialised: tools refuse rather than litter the folder.
  let a = await connect(dir, "local_aaaaaaaa-1111");
  const tools = (await a.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["ticket_claim", "ticket_create", "ticket_get", "ticket_list", "ticket_log", "ticket_update"]);
  const refused = await a.call("ticket_list");
  assert.ok(refused.isError);
  assert.match(refused.text, /No project has tickets yet/);
  assert.ok(!fs.existsSync(path.join(dir, ".tickets")));
  await a.client.close();

  new Store(dir).init();
  a = await connect(dir, "local_aaaaaaaa-1111");
  const created = await a.call("ticket_create", {
    title: "Sidebar badge flickers on workspace switch",
    body: "Seen while testing.\n\n- [ ] no flicker",
    type: "bug", priority: "P1", files: ["Sources/Views.swift"],
  });
  assert.match(created.text, /Created \[ticketdeck-mcp-\w+\] T-0001 \[todo\] P1 bug/);

  const dupe = await a.call("ticket_create", { title: "badge flickers on workspace switch", body: "" });
  assert.match(dupe.text, /Not created.*\n.*T-0001/);

  const claimed = await a.call("ticket_claim", { id: "1" });
  assert.match(claimed.text, /\[doing\].*session local_aaaaaaaa/);

  // Another session sees who holds it and is turned away.
  const b = await connect(dir, "local_bbbbbbbb-2222");
  assert.match((await b.call("ticket_claim", { id: "T-0001" })).text, /already being worked on by session local_aaaaaaaa-1111/);
  assert.match((await b.call("ticket_list")).text, /T-0001 \[doing\]/);
  assert.match((await b.call("ticket_list", { mine: true })).text, /No matching tickets/);
  await b.client.close();

  await a.call("ticket_log", { id: "1", note: "debounced redraw" });
  const done = await a.call("ticket_update", { id: "1", status: "done" });
  assert.ok(done.isError, "agents must not close tickets");
  assert.match((await a.call("ticket_update", { id: "1", status: "review", note: "ready" })).text, /\[review\]/);

  const full = (await a.call("ticket_get", { id: "1" })).text;
  assert.match(full, /session: local_aaaaaaaa-1111/);
  assert.match(full, /created_by: local_aaaaaaaa-1111/);
  assert.match(full, /debounced redraw/);
  assert.match(full, /状态 → 待验收 — ready/);

  assert.ok((await a.call("ticket_get", { id: "99" })).isError);
  await a.client.close();

  const registry = JSON.parse(fs.readFileSync(path.join(dir, ".home", "projects.json"), "utf8"));
  assert.deepEqual(registry.projects.map((p) => p.path), [dir]);
});

test("MCP: a session started in a parent folder files tickets into the right projects", { timeout: 20000 }, async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ticketdeck-multi-")));
  const home = path.join(parent, ".home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ roots: [parent] }));
  for (const name of ["Alpha", "Beta"]) {
    fs.mkdirSync(path.join(parent, name, "src"), { recursive: true });
    fs.writeFileSync(path.join(parent, name, "src", "x.ts"), "");
    execFileSync("git", ["init", "-q"], { cwd: path.join(parent, name) });
  }
  fs.mkdirSync(path.join(parent, "Notes"));

  const { client, call } = await connect(parent, "local_cccc-3333", home);

  const none = await call("ticket_list");
  assert.ok(none.isError);
  assert.match(none.text, new RegExp(`Any folder in ${parent}`));
  assert.ok((await call("ticket_claim", { id: "1" })).isError, "no project to fall back on yet");

  // Named project, case-insensitive; .tickets/ is started on first ticket.
  const a = await call("ticket_create", { project: "alpha", title: "Alpha thing", body: "b" });
  assert.match(a.text, /started \.tickets\/ in .*Alpha\)\nCreated \[Alpha\] T-0001/);

  // Project taken from a file path relative to the session folder; stored relative to the project.
  const b = await call("ticket_create", { title: "Beta thing", body: "b", files: ["Beta/src/x.ts"] });
  assert.match(b.text, /Created \[Beta\] T-0001/);
  assert.deepEqual(new Store(path.join(parent, "Beta")).get("1").files, ["src/x.ts"]);

  // Without a project the session stays on the one it used last (Beta).
  assert.match((await call("ticket_claim", { id: "1" })).text, /\[Beta\] T-0001 \[doing\]/);
  assert.equal(new Store(path.join(parent, "Alpha")).get("1").status, "todo");

  // Outside any project, a bare list covers every project.
  const all = await call("ticket_list");
  assert.match(all.text, /Alpha \(.*\):\n  T-0001 \[todo\].*Alpha thing/);
  assert.match(all.text, /Beta \(.*\):\n  T-0001 \[doing\].*Beta thing/);

  assert.match((await call("ticket_get", { project: "Alpha", id: "1" })).text, /title: Alpha thing/);

  // Logging on an unclaimed todo ticket claims it; on someone else's it only logs.
  const logged = await call("ticket_log", { project: "Alpha", id: "1", note: "started" });
  assert.match(logged.text, /\[Alpha\] T-0001 \[doing\].*session local_cccc-333[\s\S]*claimed for this session/);
  assert.equal(new Store(path.join(parent, "Alpha")).get("1").session, "local_cccc-3333");

  // Not a git repository: no tickets folder is started there.
  const notes = await call("ticket_create", { project: "Notes", title: "x", body: "" });
  assert.ok(notes.isError);
  assert.ok(!fs.existsSync(path.join(parent, "Notes", ".tickets")));
  assert.ok((await call("ticket_list", { project: "Nope" })).isError);

  await client.close();
});
