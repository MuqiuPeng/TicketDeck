// TicketDeck core: tickets are markdown files with YAML frontmatter in <repo>/.tickets/.
// Everything else (CLI, MCP server, board) goes through this module.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

export const STATUSES = ["todo", "doing", "review", "done", "dropped"] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const TYPES = ["bug", "feature", "chore", "idea"] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type TicketType = (typeof TYPES)[number];

export const OPEN_STATUSES: Status[] = ["todo", "doing", "review"];

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  priority: Priority;
  type: TicketType;
  labels: string[];
  created: string;
  updated: string;
  created_by: string;
  session: string | null;
  depends_on: string[];
  files: string[];
  /** Markdown after the frontmatter. */
  body: string;
  /** Absolute path of the file. */
  path: string;
  archived: boolean;
}

export interface Config {
  prefix: string;
  /** done/dropped tickets untouched for this many days move to archive/. 0 disables. */
  archiveAfterDays: number;
}

const DEFAULT_CONFIG: Config = { prefix: "T", archiveAfterDays: 14 };
export const TICKETS_DIR = ".tickets";
const LOG_HEADING = "## Log";

export class TicketError extends Error {}

// MARK: Locating the project

/**
 * The folder that owns `.tickets/`. Inside a git worktree this is the main checkout, so every
 * worktree (and every Claude session working in one) shares the same tickets.
 */
export function projectRoot(cwd: string = process.cwd()): string {
  if (process.env.TICKETDECK_ROOT) return path.resolve(process.env.TICKETDECK_ROOT);
  // An explicitly initialised folder wins over git.
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, TICKETS_DIR))) return mainCheckout(dir) ?? dir;
    if (path.dirname(dir) === dir) break;
  }
  return mainCheckout(cwd) ?? gitToplevel(cwd) ?? path.resolve(cwd);
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function gitToplevel(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** For a linked worktree, the main working tree; for the main one, itself. */
function mainCheckout(cwd: string): string | null {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || path.basename(common) !== ".git") return null;
  const main = path.dirname(common);
  return fs.existsSync(path.join(main, TICKETS_DIR)) || !fs.existsSync(path.join(cwd, TICKETS_DIR)) ? main : null;
}

// MARK: Store

export class Store {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = path.join(root, TICKETS_DIR);
  }

  static open(cwd?: string): Store {
    return new Store(projectRoot(cwd));
  }

  get initialized(): boolean {
    return fs.existsSync(this.dir);
  }

  requireInit(): void {
    if (!this.initialized)
      throw new TicketError(`No ${TICKETS_DIR}/ in ${this.root}. Run \`ticketdeck init\` there first.`);
  }

  init(): void {
    fs.mkdirSync(path.join(this.dir, "archive"), { recursive: true });
    const cfg = path.join(this.dir, "config.json");
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }

  config(): Config {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(path.join(this.dir, "config.json"), "utf8")) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  // MARK: Reading

  private files(includeArchive: boolean): { file: string; archived: boolean }[] {
    const out: { file: string; archived: boolean }[] = [];
    const scan = (dir: string, archived: boolean) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir))
        if (name.endsWith(".md") && !name.startsWith(".")) out.push({ file: path.join(dir, name), archived });
    };
    scan(this.dir, false);
    if (includeArchive) scan(path.join(this.dir, "archive"), true);
    return out;
  }

  all(opts: { includeArchive?: boolean } = {}): Ticket[] {
    const tickets: Ticket[] = [];
    for (const { file, archived } of this.files(opts.includeArchive ?? false)) {
      try {
        tickets.push(parseTicket(fs.readFileSync(file, "utf8"), file, archived));
      } catch {
        // A file someone is half-way through editing; skip it rather than fail the listing.
      }
    }
    return tickets.sort(compareTickets);
  }

  list(filter: ListFilter = {}): Ticket[] {
    this.autoArchive();
    const statuses = filter.status?.length ? filter.status : filter.includeClosed ? [...STATUSES] : OPEN_STATUSES;
    return this.all({ includeArchive: filter.includeClosed }).filter(
      (t) =>
        statuses.includes(t.status) &&
        (!filter.label || t.labels.includes(filter.label)) &&
        (!filter.session || t.session === filter.session) &&
        (!filter.type || t.type === filter.type),
    );
  }

  get(id: string): Ticket {
    const want = normalizeId(id, this.config().prefix);
    const t = this.all({ includeArchive: true }).find((t) => t.id === want);
    if (!t) throw new TicketError(`No ticket ${want}.`);
    return t;
  }

  // MARK: Writing

  create(input: CreateInput, actor: string): CreateResult {
    this.requireInit();
    const title = input.title.trim();
    if (!title) throw new TicketError("title is required.");
    const depends_on = (input.depends_on ?? []).map((d) => normalizeId(d, this.config().prefix));
    this.checkDeps(depends_on);

    if (!input.force) {
      const dupes = findDuplicates(this.list(), title, input.files ?? []);
      if (dupes.length) return { duplicates: dupes };
    }

    return this.withLock(() => {
      const id = this.nextId();
      const now = timestamp();
      const t: Ticket = {
        id,
        title,
        status: "todo",
        priority: check(input.priority ?? "P2", PRIORITIES, "priority"),
        type: check(input.type ?? "feature", TYPES, "type"),
        labels: input.labels ?? [],
        created: now,
        updated: now,
        created_by: actor,
        session: null,
        depends_on,
        files: input.files ?? [],
        body: "",
        path: path.join(this.dir, `${id}${slug(title)}.md`),
        archived: false,
      };
      t.body = `${(input.body ?? "").trim()}\n\n${LOG_HEADING}\n${logLine(now, actor, "created")}\n`.trimStart();
      fs.writeFileSync(t.path, serializeTicket(t), { flag: "wx" });
      return { ticket: t };
    });
  }

  update(id: string, patch: TicketPatch, actor: string): Ticket {
    return this.withLock(() => {
      const t = this.get(id);
      const changes: string[] = [];
      const set = <K extends keyof TicketPatch & keyof Ticket>(key: K, value: Ticket[K] | undefined) => {
        if (value === undefined || JSON.stringify(t[key]) === JSON.stringify(value)) return;
        changes.push(Array.isArray(value) ? `${key} → [${value.join(", ")}]` : `${key} → ${value}`);
        (t as any)[key] = value;
      };
      if (patch.title !== undefined) set("title", patch.title.trim());
      if (patch.status !== undefined) set("status", check(patch.status, STATUSES, "status"));
      if (patch.priority !== undefined) set("priority", check(patch.priority, PRIORITIES, "priority"));
      if (patch.type !== undefined) set("type", check(patch.type, TYPES, "type"));
      set("labels", patch.labels);
      set("files", patch.files);
      set("session", patch.session);
      if (patch.depends_on) {
        const deps = patch.depends_on.map((d) => normalizeId(d, this.config().prefix));
        this.checkDeps(deps, t.id);
        set("depends_on", deps);
      }
      if (!changes.length && !patch.note) return t;

      t.updated = timestamp();
      const note = [changes.join(", "), patch.note?.trim()].filter(Boolean).join(" — ");
      t.body = appendLog(t.body, logLine(t.updated, actor, note));
      this.write(t);
      return t;
    });
  }

  claim(id: string, session: string, actor: string): Ticket {
    const t = this.get(id);
    if (t.status === "done" || t.status === "dropped")
      throw new TicketError(`${t.id} is ${t.status}; reopen it with status=todo first.`);
    return this.update(id, { status: "doing", session, note: "claimed" }, actor);
  }

  log(id: string, note: string, actor: string): Ticket {
    if (!note.trim()) throw new TicketError("note is empty.");
    return this.update(id, { note }, actor);
  }

  /**
   * Ticks or unticks the `index`-th "- [ ]" item of the body (0-based, in document order),
   * as the board's checkboxes do. Logged like any other change.
   */
  setChecked(id: string, index: number, checked: boolean, actor: string): Ticket {
    return this.withLock(() => {
      const t = this.get(id);
      let n = -1;
      let text = "";
      const body = t.body.replace(/^(\s*[-*+]\s+\[)([ xX])(\]\s*)(.*)$/gm, (all, a, mark, b, rest) => {
        if (++n !== index) return all;
        text = rest.trim();
        return `${a}${checked ? "x" : " "}${b}${rest}`;
      });
      if (n < index) throw new TicketError(`${t.id} has no checklist item ${index + 1}.`);
      if (body === t.body) return t;
      t.updated = timestamp();
      t.body = appendLog(body, logLine(t.updated, actor, `${checked ? "checked" : "unchecked"}: ${text}`));
      this.write(t);
      return t;
    });
  }

  private checkDeps(ids: string[], self?: string): void {
    const known = new Set(this.all({ includeArchive: true }).map((t) => t.id));
    const bad = ids.filter((d) => d === self || !known.has(d));
    if (bad.length) throw new TicketError(`depends_on: no such ticket ${bad.join(", ")}.`);
  }

  private write(t: Ticket): void {
    // Keep the file name in step with the title, so `ls .tickets` stays readable.
    const dir = path.dirname(t.path);
    const want = path.join(dir, `${t.id}${slug(t.title)}.md`);
    const tmp = path.join(dir, `.${t.id}.tmp`);
    fs.writeFileSync(tmp, serializeTicket(t));
    fs.renameSync(tmp, want);
    if (want !== t.path) fs.rmSync(t.path, { force: true });
    t.path = want;
  }

  /** Moves done/dropped tickets that have sat untouched for a while into archive/. */
  autoArchive(): void {
    if (!this.initialized) return;
    const days = this.config().archiveAfterDays;
    if (!days) return;
    const cutoff = Date.now() - days * 86_400_000;
    for (const t of this.all())
      if ((t.status === "done" || t.status === "dropped") && Date.parse(t.updated) < cutoff) {
        fs.mkdirSync(path.join(this.dir, "archive"), { recursive: true });
        fs.renameSync(t.path, path.join(this.dir, "archive", path.basename(t.path)));
      }
  }

  private nextId(): string {
    const { prefix } = this.config();
    let max = 0;
    for (const { file } of this.files(true)) {
      const m = path.basename(file).match(/^[A-Za-z]+-(\d+)/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}-${String(max + 1).padStart(4, "0")}`;
  }

  /** Serialises writers across processes (several Claude sessions share one project). */
  private withLock<T>(fn: () => T): T {
    const lock = path.join(this.dir, ".lock");
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true });
        } catch {}
        if (Date.now() > deadline) throw new TicketError("Timed out waiting for .tickets/.lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}

export interface ListFilter {
  status?: Status[];
  includeClosed?: boolean;
  label?: string;
  type?: TicketType;
  session?: string;
}

export interface CreateInput {
  title: string;
  body?: string;
  type?: TicketType;
  priority?: Priority;
  labels?: string[];
  depends_on?: string[];
  files?: string[];
  /** Skip the duplicate check. */
  force?: boolean;
}

export interface CreateResult {
  ticket?: Ticket;
  duplicates?: Ticket[];
}

export interface TicketPatch {
  title?: string;
  status?: Status;
  priority?: Priority;
  type?: TicketType;
  labels?: string[];
  depends_on?: string[];
  files?: string[];
  session?: string | null;
  /** Free text appended to the log together with the change. */
  note?: string;
}

// MARK: Parsing and serialising

const FIELD_ORDER = [
  "id", "title", "status", "priority", "type", "labels", "created", "updated",
  "created_by", "session", "depends_on", "files",
] as const;

export function parseTicket(text: string, file: string, archived = false): Ticket {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new TicketError(`${file}: missing frontmatter`);
  const d = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  const id = str(d.id) || path.basename(file).match(/^[A-Za-z]+-\d+/)?.[0] || "";
  if (!id) throw new TicketError(`${file}: no id`);
  return {
    id,
    title: str(d.title, id),
    status: oneOf(d.status, STATUSES, "todo"),
    priority: oneOf(d.priority, PRIORITIES, "P2"),
    type: oneOf(d.type, TYPES, "feature"),
    labels: list(d.labels),
    created: str(d.created),
    updated: str(d.updated ?? d.created),
    created_by: str(d.created_by, "user"),
    session: d.session ? String(d.session) : null,
    depends_on: list(d.depends_on),
    files: list(d.files),
    body: m[2].replace(/^\r?\n/, ""),
    path: file,
    archived,
  };
}

export function serializeTicket(t: Ticket): string {
  const lines = FIELD_ORDER.map((k) => {
    const v = t[k];
    if (Array.isArray(v))
      return `${k}: ${YAML.stringify(v, { lineWidth: 0, collectionStyle: "flow", flowCollectionPadding: false }).trim()}`;
    return `${k}: ${v == null ? "" : scalar(v)}`.trimEnd();
  });
  return `---\n${lines.join("\n")}\n---\n\n${t.body.replace(/^\n+/, "").replace(/\n*$/, "\n")}`;
}

function scalar(v: unknown): string {
  return YAML.stringify(v, { lineWidth: 0, defaultStringType: "PLAIN" }).trim();
}

// MARK: Helpers

export function normalizeId(id: string, prefix = "T"): string {
  const s = id.trim();
  const m = s.match(/^([A-Za-z]+)?-?(\d+)$/);
  if (!m) return s.toUpperCase();
  return `${(m[1] ?? prefix).toUpperCase()}-${m[2].padStart(4, "0")}`;
}

function slug(title: string): string {
  const s = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s ? `-${s}` : "";
}

function check<T extends string>(v: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(v))
    throw new TicketError(`${name} must be one of ${allowed.join(", ")} (got "${v}").`);
  return v as T;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STATUS_RANK: Record<string, number> = { doing: 0, review: 1, todo: 2, done: 3, dropped: 4 };

function compareTickets(a: Ticket, b: Ticket): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
}

/** Local time with offset, to the minute: 2026-11-09T10:12+08:00 */
export function timestamp(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`
  );
}

function logLine(ts: string, actor: string, note: string): string {
  const when = ts.slice(0, 16).replace("T", " ");
  return `- ${when} · ${shortActor(actor)} · ${note.replace(/\s*\n\s*/g, " ")}`;
}

export function shortActor(actor: string): string {
  return actor.startsWith("local_") ? actor.slice(0, 14) : actor;
}

function appendLog(body: string, line: string): string {
  const b = body.replace(/\s*$/, "");
  return (b.includes(`\n${LOG_HEADING}\n`) || b.startsWith(`${LOG_HEADING}\n`) || b.endsWith(LOG_HEADING)
    ? `${b}\n${line}`
    : `${b}\n\n${LOG_HEADING}\n${line}`
  ).replace(/^\n+/, "") + "\n";
}

// MARK: Duplicate detection

/** Word tokens for Latin text plus character bigrams for CJK, so both kinds of title compare. */
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.normalize("NFKC").toLowerCase();
  for (const w of t.match(/[a-z0-9]+/g) ?? []) if (w.length > 1 && !STOP.has(w)) out.add(w);
  for (const run of t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

const STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "be", "with", "when", "should"]);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

export function findDuplicates(open: Ticket[], title: string, files: string[]): Ticket[] {
  const tt = tokens(title);
  return open.filter((t) => {
    const sim = jaccard(tt, tokens(t.title));
    const sharesFile = files.some((f) => t.files.includes(f));
    return sim >= 0.5 || (sharesFile && sim >= 0.25);
  });
}

// MARK: Who is acting

/**
 * The Claude Code session this process belongs to. Claude desktop exports its own session id
 * (local_…, the one its deep links take); plain Claude Code exports a UUID.
 */
export function currentSession(): string | null {
  return process.env.CLAUDE_CODE_HOST_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
}

// MARK: Project registry (~/.ticketdeck/projects.json), for the cross-project board

export function ticketdeckHome(): string {
  return process.env.TICKETDECK_HOME ?? path.join(os.homedir(), ".ticketdeck");
}

export function registerProject(root: string): void {
  try {
    const file = path.join(ticketdeckHome(), "projects.json");
    let data: { projects: { path: string; lastUsed: string }[] } = { projects: [] };
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const now = new Date().toISOString();
    const hit = data.projects.find((p) => p.path === root);
    if (hit) {
      if (Date.now() - Date.parse(hit.lastUsed) < 60_000) return;
      hit.lastUsed = now;
    } else data.projects.push({ path: root, lastUsed: now });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // The registry is a convenience for the board; never fail a ticket operation over it.
  }
}

export function registeredProjects(): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ticketdeckHome(), "projects.json"), "utf8"));
    return data.projects.map((p: { path: string }) => p.path);
  } catch {
    return [];
  }
}

// MARK: Formatting shared by the CLI and MCP server

export function summaryLine(t: Ticket): string {
  const extra = [
    t.session ? `session ${shortActor(t.session)}` : "",
    t.depends_on.length ? `needs ${t.depends_on.join(",")}` : "",
    t.labels.length ? `#${t.labels.join(" #")}` : "",
  ].filter(Boolean);
  return `${t.id} [${t.status}] ${t.priority} ${t.type} — ${t.title}${extra.length ? `  (${extra.join("; ")})` : ""}`;
}
