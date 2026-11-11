// `ticketdeck serve`: the board. A small HTTP server on localhost with a JSON API over the
// same Store the CLI and MCP server use, and server-sent events whenever a .tickets/ folder
// changes, so the page follows the agents' edits live.

import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRIORITIES, STATUSES, Store, TICKETS_DIR, TYPES, TicketError, registerProject, ticketdeckHome,
  type TicketPatch,
} from "./core.js";
import { boardState, knownProjects, ticketJSON } from "./projects.js";
import { listReports, readReport, reportsDir } from "./report.js";

const ACTOR = "user";
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MARKED = path.join(path.dirname(createRequire(import.meta.url).resolve("marked")), "marked.esm.js");

const STATIC: Record<string, [string, string]> = {
  "/": [path.join(WEB, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(WEB, "app.js"), "text/javascript; charset=utf-8"],
  "/style.css": [path.join(WEB, "style.css"), "text/css; charset=utf-8"],
  "/vendor/marked.js": [MARKED, "text/javascript; charset=utf-8"],
};

export interface ServeOptions {
  port: number;
  host?: string;
}

export interface Board {
  url: string;
  close(): Promise<void>;
}

export function serve(opts: ServeOptions): Promise<Board> {
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<http.ServerResponse>();
  const watch = new Watcher(() => {
    for (const res of clients) res.write(`event: change\ndata: {}\n\n`);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: "bad host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
        return void res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && url.pathname === "/api/state")
        return send(res, 200, state(url.searchParams.get("closed") === "1"));
      if (req.method === "GET" && url.pathname === "/api/reports") return send(res, 200, { dates: listReports() });
      if (req.method === "GET" && url.pathname === "/api/report") {
        const date = url.searchParams.get("date") ?? listReports()[0] ?? "";
        const report = readReport(date);
        return report == null ? send(res, 404, { error: "no report" }) : send(res, 200, report);
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: hello\ndata: {}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        // JSON only: a cross-site form cannot send it without a preflight we never answer.
        if (!String(req.headers["content-type"]).startsWith("application/json"))
          return send(res, 415, { error: "JSON only" });
        if (req.headers.origin && !allowedHost(req.headers.origin.replace(/^https?:\/\//, ""), port))
          return send(res, 403, { error: "bad origin" });
        const body = JSON.parse((await readBody(req)) || "{}");
        const result = post(url.pathname, body);
        watch.poke();
        return send(res, 200, result);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof TicketError || e instanceof SyntaxError) return send(res, 400, { error: (e as Error).message });
      console.error(e);
      send(res, 500, { error: String(e) });
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(`: ping\n\n`);
  }, 25_000);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://${host === "127.0.0.1" ? "localhost" : host}:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            watch.close();
            for (const res of clients) res.end();
            server.close(() => done());
          }),
      });
    });
  });
}

function allowedHost(h: string | undefined, port: number): boolean {
  return !!h && [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(h);
}

function send(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      s += c;
      if (s.length > 1_000_000) reject(new TicketError("body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

// MARK: API

function state(includeClosed: boolean) {
  return { statuses: STATUSES, priorities: PRIORITIES, types: TYPES, ...boardState(includeClosed) };
}

const toJSON = ticketJSON;

/** The store for a project the board knows; never an arbitrary path from the request. */
function storeFor(project: unknown): Store {
  const root = knownProjects().find((p) => p === project);
  if (!root) throw new TicketError(`Unknown project ${String(project)}.`);
  return new Store(root);
}

function post(route: string, b: Record<string, any>) {
  switch (route) {
    case "/api/update": {
      const patch: TicketPatch = {};
      for (const k of ["status", "priority", "type", "title", "labels", "depends_on", "note"] as const)
        if (b[k] !== undefined) (patch as any)[k] = b[k];
      if (b.release) patch.session = null;
      return toJSON(storeFor(b.project).update(String(b.id), patch, ACTOR));
    }
    case "/api/check":
      return toJSON(storeFor(b.project).setChecked(String(b.id), Number(b.index), !!b.checked, ACTOR));
    case "/api/log":
      return toJSON(storeFor(b.project).log(String(b.id), String(b.note ?? ""), ACTOR));
    case "/api/create": {
      const store = storeFor(b.project);
      const r = store.create(
        {
          title: String(b.title ?? ""),
          body: String(b.body ?? ""),
          type: b.type,
          priority: b.priority,
          labels: Array.isArray(b.labels) ? b.labels.map(String) : [],
          force: !!b.force,
        },
        ACTOR,
      );
      registerProject(store.root);
      return r.ticket ? { ticket: toJSON(r.ticket) } : { duplicates: r.duplicates!.map(toJSON) };
    }
  }
  throw new TicketError(`No route ${route}.`);
}

// MARK: Watching

/**
 * Watches every known project's .tickets/ (and archive/) plus the registry, and calls
 * `onChange` once per burst of file events. Re-scans for new projects every few seconds,
 * since a session can start .tickets/ in a repository the board has never seen.
 */
class Watcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private rescan: NodeJS.Timeout;

  constructor(private onChange: () => void) {
    this.sync();
    this.rescan = setInterval(() => this.sync(), 5000);
  }

  poke(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, 120);
  }

  private sync(): void {
    const dirs = new Set<string>([ticketdeckHome(), reportsDir()]);
    for (const p of knownProjects()) {
      dirs.add(path.join(p, TICKETS_DIR));
      dirs.add(path.join(p, TICKETS_DIR, "archive"));
    }
    let added = false;
    for (const d of dirs) {
      if (this.watchers.has(d) || !fs.existsSync(d)) continue;
      try {
        const w = fs.watch(d, (_e, name) => {
          if (name && (String(name).startsWith(".lock") || String(name).endsWith(".tmp"))) return;
          this.poke();
        });
        w.on("error", () => this.drop(d));
        this.watchers.set(d, w);
        added = true;
      } catch {}
    }
    for (const d of [...this.watchers.keys()]) if (!dirs.has(d) || !fs.existsSync(d)) this.drop(d);
    if (added) this.poke();
  }

  private drop(d: string): void {
    this.watchers.get(d)?.close();
    this.watchers.delete(d);
  }

  close(): void {
    clearInterval(this.rescan);
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
