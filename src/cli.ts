#!/usr/bin/env node
// ticketdeck: the human side of TicketDeck.

import * as fs from "node:fs";
import { parseArgs } from "node:util";
import {
  PRIORITIES, STATUSES, TYPES, Store, TicketError, registerProject, summaryLine,
  type Priority, type Status, type TicketPatch, type TicketType,
} from "./core.js";
import { installGlobalMcp, installMcp, installRules } from "./install.js";
import { boardState, expand, globalConfig, knownProjects, roots, saveCliLocation, saveGlobalConfig, ticketJSON } from "./projects.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { serve } from "./server.js";
import { buildReport, listReports, localDate, readReport, saveReport } from "./report.js";

const HELP = `ticketdeck — tickets your coding agent manages, stored in .tickets/

Usage:
  ticketdeck setup [--root ~/projects]...   once: register the MCP server for every Claude session
  ticketdeck init [--no-rules] [--mcp]      start .tickets/ in the current project
  ticketdeck projects                       projects with tickets, and where names are looked up
  ticketdeck list [-a] [-s status,...] [-l label]
  ticketdeck new "title" [-t type] [-p priority] [-l label]... [-b body] [--force]
  ticketdeck show <id>
  ticketdeck set <id> key=value...          status, priority, type, title, labels, depends_on, files
  ticketdeck log <id> "note"
  ticketdeck done <id>                      shorthand for set <id> status=done
  ticketdeck check <id> <n> [on|off]        tick checklist item n (1-based)
  ticketdeck state [--closed]               every project's tickets as JSON (for TabStack)
  ticketdeck serve [--port 4477] [--open]   the web board on localhost
  ticketdeck report [--save] [--hours 24]   daily report of every project's tickets
  ticketdeck reports [--show <date>]        saved reports, newest first
  ticketdeck where                          print the project folder and tickets path

Statuses:   ${STATUSES.join(", ")}
Priorities: ${PRIORITIES.join(", ")}
Types:      ${TYPES.join(", ")}`;

const ACTOR = "user";

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const store = Store.open();

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;

    case "setup": {
      const { values } = parseArgs({ args: rest, options: { root: { type: "string", multiple: true } } });
      if (values.root?.length) {
        const cfg = globalConfig();
        cfg.roots = [...new Set([...cfg.roots, ...values.root.map(expand)])];
        saveGlobalConfig(cfg);
      }
      saveCliLocation(fileURLToPath(import.meta.url));
      const r = installGlobalMcp();
      if (r.ok) console.log("Registered the ticketdeck MCP server for your user (claude mcp, scope user).");
      else console.log(`Could not find the claude CLI. Run this yourself:\n  ${r.command}`);
      console.log(`Project names are looked up in: ${roots().join(", ") || "(none yet — pass --root ~/projects)"}`);
      console.log("New Claude sessions pick it up; existing ones need restarting.");
      return 0;
    }

    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: { "no-rules": { type: "boolean" }, mcp: { type: "boolean" } },
      });
      const fresh = !store.initialized;
      store.init();
      console.log(`${fresh ? "Created" : "Found"} ${store.dir}`);
      if (!values["no-rules"]) console.log(`CLAUDE.md: ticket section ${installRules(store.root)}`);
      if (values.mcp) console.log(`.mcp.json: ticketdeck server ${installMcp(store.root)}`);
      registerProject(store.root);
      return 0;
    }

    case "projects": {
      const known = knownProjects();
      for (const p of known) console.log(`${p}  (${new Store(p).list().length} open)`);
      if (!known.length) console.log("No projects with tickets yet.");
      console.log(`\nNames are looked up in: ${roots().join(", ") || "(none)"}`);
      return 0;
    }

    case "where":
      console.log(`project: ${store.root}\ntickets: ${store.dir}${store.initialized ? "" : " (not initialised)"}`);
      return 0;

    case "list":
    case "ls": {
      store.requireInit();
      const { values } = parseArgs({
        args: rest,
        options: {
          all: { type: "boolean", short: "a" },
          status: { type: "string", short: "s" },
          label: { type: "string", short: "l" },
        },
      });
      const tickets = store.list({
        includeClosed: values.all,
        status: values.status?.split(",").map((s) => s.trim() as Status),
        label: values.label,
      });
      if (!tickets.length) console.log(values.all ? "No tickets." : "No open tickets.");
      for (const t of tickets) console.log(summaryLine(t));
      return 0;
    }

    case "new":
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          type: { type: "string", short: "t" },
          priority: { type: "string", short: "p" },
          label: { type: "string", short: "l", multiple: true },
          body: { type: "string", short: "b" },
          force: { type: "boolean" },
        },
      });
      const title = positionals.join(" ");
      if (!title) throw new TicketError('usage: ticketdeck new "title"');
      const r = store.create(
        {
          title,
          body: values.body ?? (process.stdin.isTTY ? "" : readStdin()),
          type: values.type as TicketType | undefined,
          priority: values.priority?.toUpperCase() as Priority | undefined,
          labels: values.label,
          force: values.force,
        },
        ACTOR,
      );
      if (r.duplicates) {
        console.error("Possible duplicates (use --force to create anyway):");
        for (const t of r.duplicates) console.error("  " + summaryLine(t));
        return 2;
      }
      console.log(`Created ${r.ticket!.id}: ${r.ticket!.path}`);
      registerProject(store.root);
      return 0;
    }

    case "show":
    case "cat": {
      const t = store.get(need(rest[0], "id"));
      process.stdout.write(fs.readFileSync(t.path, "utf8"));
      return 0;
    }

    case "set": {
      const id = need(rest[0], "id");
      const patch: TicketPatch = {};
      for (const kv of rest.slice(1)) {
        const i = kv.indexOf("=");
        if (i < 0) throw new TicketError(`expected key=value, got "${kv}"`);
        const key = kv.slice(0, i);
        const value = kv.slice(i + 1);
        const list = () => value.split(",").map((s) => s.trim()).filter(Boolean);
        switch (key) {
          case "status": patch.status = value as Status; break;
          case "priority": patch.priority = value.toUpperCase() as Priority; break;
          case "type": patch.type = value as TicketType; break;
          case "title": patch.title = value; break;
          case "labels": patch.labels = list(); break;
          case "depends_on": patch.depends_on = list(); break;
          case "files": patch.files = list(); break;
          case "session": patch.session = value || null; break;
          case "note": patch.note = value; break;
          default: throw new TicketError(`unknown field "${key}"`);
        }
      }
      console.log(summaryLine(store.update(id, patch, ACTOR)));
      return 0;
    }

    case "log":
      console.log(summaryLine(store.log(need(rest[0], "id"), rest.slice(1).join(" "), ACTOR)));
      return 0;

    case "state": {
      const { values } = parseArgs({ args: rest, options: { closed: { type: "boolean" }, json: { type: "boolean" } } });
      console.log(JSON.stringify(boardState(values.closed)));
      return 0;
    }

    case "report": {
      const { values } = parseArgs({ args: rest, options: { save: { type: "boolean" }, hours: { type: "string" } } });
      const md = buildReport(new Date(), Number(values.hours ?? 24));
      if (values.save) console.log(saveReport(md, localDate()));
      else process.stdout.write(md);
      return 0;
    }

    case "reports": {
      const { values } = parseArgs({ args: rest, options: { show: { type: "string" } } });
      if (values.show) {
        const md = readReport(values.show);
        if (md == null) throw new TicketError(`No report for ${values.show}.`);
        process.stdout.write(md);
      } else console.log(listReports().join("\n") || "No reports yet.");
      return 0;
    }

    case "serve": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string", short: "p" }, open: { type: "boolean" } },
      });
      const port = Number(values.port ?? process.env.TICKETDECK_PORT ?? 4477);
      serve({ port }).then(
        (board) => {
          console.log(`TicketDeck board: ${board.url}  (Ctrl-C to stop)`);
          if (values.open) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [board.url], { stdio: "ignore", detached: true }).unref();
          const stop = () => board.close().then(() => process.exit(0));
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        },
        (e) => {
          console.error(`ticketdeck: ${e.code === "EADDRINUSE" ? `port ${port} is in use (another board running? try --port)` : e.message}`);
          process.exit(1);
        },
      );
      return 0;
    }

    case "check": {
      const id = need(rest[0], "id");
      const n = Number(need(rest[1], "item number"));
      if (!Number.isInteger(n) || n < 1) throw new TicketError("item number must be 1 or more");
      const on = (rest[2] ?? "on") !== "off";
      console.log(JSON.stringify(ticketJSON(store.setChecked(id, n - 1, on, ACTOR))));
      return 0;
    }

    case "done":
      console.log(summaryLine(store.update(need(rest[0], "id"), { status: "done" }, ACTOR)));
      return 0;

    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 1;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new TicketError(`missing ${what}`);
  return v;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof TicketError || (e as any)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    console.error(`ticketdeck: ${(e as Error).message}`);
    process.exitCode = 1;
  } else throw e;
}
