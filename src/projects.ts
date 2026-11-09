// Which project a ticket belongs to, when the session is not necessarily inside it.
// A Claude session may be started in ~/projects while it works on ~/projects/TabStack, so
// the project is taken, in order, from: what the agent names, the files it mentions, the
// folder the session runs in, and the project it used last.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, TICKETS_DIR, TicketError, projectRoot, registeredProjects, ticketdeckHome } from "./core.js";

export interface GlobalConfig {
  /** Folders whose sub-folders are projects, e.g. ~/projects. */
  roots: string[];
}

const configFile = () => path.join(ticketdeckHome(), "config.json");

export function globalConfig(): GlobalConfig {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    return { roots: Array.isArray(c.roots) ? c.roots.map(expand) : [] };
  } catch {
    return { roots: [] };
  }
}

export function saveGlobalConfig(c: GlobalConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2) + "\n");
}

export function expand(p: string): string {
  return path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
}

/** Roots from the config plus the parents of every project used so far. */
export function roots(): string[] {
  const set = new Set(globalConfig().roots);
  for (const p of registeredProjects()) set.add(path.dirname(p));
  return [...set].filter((r) => isDir(r));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Projects that already have tickets: the registry plus any root child with .tickets/. */
export function knownProjects(): string[] {
  const set = new Set(registeredProjects().filter((p) => isDir(path.join(p, TICKETS_DIR))));
  for (const r of roots())
    for (const name of safeReaddir(r)) {
      const p = path.join(r, name);
      if (isDir(path.join(p, TICKETS_DIR))) set.add(p);
    }
  return [...set].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/** A project by folder name (case-insensitive) or path. */
export function resolveProject(ref: string, cwd = process.cwd()): string {
  const r = ref.trim();
  if (!r) throw new TicketError("project is empty.");
  if (r.startsWith("/") || r.startsWith("~") || r.startsWith(".")) {
    const p = r.startsWith(".") ? path.resolve(cwd, r) : expand(r);
    if (!isDir(p)) throw new TicketError(`No folder ${p}.`);
    return projectRoot(p);
  }
  const want = r.toLowerCase();
  const hits = new Set<string>();
  for (const p of registeredProjects()) if (path.basename(p).toLowerCase() === want && isDir(p)) hits.add(p);
  for (const root of roots())
    for (const name of safeReaddir(root))
      if (name.toLowerCase() === want && isDir(path.join(root, name))) hits.add(path.join(root, name));
  if (hits.size === 1) return projectRoot([...hits][0]);
  if (hits.size > 1)
    throw new TicketError(`"${r}" matches several folders; pass the path instead:\n${[...hits].join("\n")}`);
  throw new TicketError(`No project named "${r}". ${describeKnown()}`);
}

/** The project containing these paths (absolute, or relative to cwd), if they agree on one. */
export function projectOfFiles(files: string[], cwd = process.cwd()): string | null {
  const found = new Set<string>();
  for (const f of files) {
    let p = path.isAbsolute(f) ? f : f.startsWith("~") ? expand(f) : path.resolve(cwd, f);
    while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
    if (!fs.existsSync(p)) continue;
    const dir = isDir(p) ? p : path.dirname(p);
    const root = projectRoot(dir);
    // A file that only resolves to the session folder itself tells us nothing.
    if (root !== path.resolve(cwd) || new Store(root).initialized) found.add(root);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function describeKnown(): string {
  const known = knownProjects();
  const parts = [];
  if (known.length) parts.push(`Projects with tickets: ${known.map((p) => path.basename(p)).join(", ")}.`);
  const rs = roots();
  if (rs.length) parts.push(`Any folder in ${rs.join(", ")} can be named too.`);
  if (!parts.length) parts.push("No projects are known yet; pass a path.");
  return parts.join(" ");
}

export interface ResolveInput {
  project?: string;
  files?: string[];
}

export interface Resolved {
  store: Store;
  /** How it was chosen, for messages. */
  via: "project" | "files" | "cwd" | "last";
}

/**
 * Picks the project for a tool call. `last` is the project this session used before, a
 * fallback so an agent that named the project once need not repeat it on every call.
 */
export function pickProject(input: ResolveInput, last: string | null, cwd = process.cwd()): Resolved | null {
  if (input.project) return { store: new Store(resolveProject(input.project, cwd)), via: "project" };
  const byFiles = input.files?.length ? projectOfFiles(input.files, cwd) : null;
  if (byFiles) return { store: new Store(byFiles), via: "files" };
  const here = Store.open(cwd);
  if (here.initialized) return { store: here, via: "cwd" };
  if (last) return { store: new Store(last), via: "last" };
  return null;
}

/** Whether a folder looks like a code project we may create .tickets/ in. */
export function isRepo(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}
