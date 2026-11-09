// Daily report: a markdown digest of every project's tickets, kept in ~/.ticketdeck/reports/
// as <YYYY-MM-DD>.md. `ticketdeck report --save` writes the factual part; the 8:00 scheduled
// Claude task then adds a summary and what yesterday's sessions left untracked. The web board
// and TabStack's ⌃⌥T panel show the newest one.

import * as fs from "node:fs";
import * as path from "node:path";
import { Store, shortActor, ticketdeckHome, type Ticket } from "./core.js";
import { knownProjects } from "./projects.js";

export function reportsDir(): string {
  return path.join(ticketdeckHome(), "reports");
}

export function listReports(): string[] {
  try {
    return fs
      .readdirSync(reportsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function readReport(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return fs.readFileSync(path.join(reportsDir(), `${date}.md`), "utf8");
  } catch {
    return null;
  }
}

export function saveReport(markdown: string, date: string): string {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const file = path.join(reportsDir(), `${date}.md`);
  fs.writeFileSync(file, markdown.replace(/\n*$/, "\n"));
  return file;
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Item extends Ticket {
  project: string;
}

interface LogEntry {
  at: Date;
  actor: string;
  note: string;
}

/** The "## Log" lines of a ticket: "- 2026-11-09 11:40 · actor · note". */
function logEntries(t: Ticket): LogEntry[] {
  const i = t.body.indexOf("## Log");
  if (i < 0) return [];
  const out: LogEntry[] = [];
  for (const line of t.body.slice(i).split("\n")) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · (.+?) · (.*)$/);
    if (m) out.push({ at: new Date(`${m[1]}T${m[2]}:00`), actor: m[3], note: m[4] });
  }
  return out;
}

function ago(from: Date, now: Date): string {
  const h = (now.getTime() - from.getTime()) / 3_600_000;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const ref = (t: Item) => `**${t.project}** ${t.id} ${t.title}`;
const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>;

/** The factual report for the `hours` before `now`. */
export function buildReport(now = new Date(), hours = 24): string {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const projects = knownProjects().map((root) => ({
    name: path.basename(root),
    tickets: new Store(root).list({ includeClosed: true }).map((t) => ({ ...t, project: path.basename(root) })) as Item[],
  }));
  const all = projects.flatMap((p) => p.tickets).filter((t) => !t.archived);
  const open = all.filter((t) => ["todo", "doing", "review"].includes(t.status));
  const byPrio = (a: Item, b: Item) => PRIO[a.priority] - PRIO[b.priority] || a.project.localeCompare(b.project);

  const out: string[] = [];
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  out.push(`# Daily report — ${localDate(now)} (${weekday})`, "");
  out.push(
    `_Generated ${now.toTimeString().slice(0, 5)} · covers the last ${hours} h · ${open.length} open tickets in ${
      new Set(open.map((t) => t.project)).size
    } projects_`,
    "",
  );

  // Needs you
  out.push("## Needs you", "");
  const review = all.filter((t) => t.status === "review").sort(byPrio);
  if (review.length) {
    out.push(`**Ready for review (${review.length})** — close with ⌘D in ⌃⌥T or ✓ Done on the board:`);
    for (const t of review) out.push(`- ${ref(t)} — waiting ${ago(new Date(t.updated), now)}`);
  } else out.push("Nothing is waiting for review.");
  const waiting = open.filter((t) => t.status === "todo" && t.labels.some((l) => l === "decision" || l === "needs-user"));
  if (waiting.length) {
    out.push("", `**Waiting on your decision or action (${waiting.length})**, most important first:`);
    for (const t of waiting.sort(byPrio).slice(0, 8)) out.push(`- ${t.priority} ${ref(t)}`);
    if (waiting.length > 8) out.push(`- …and ${waiting.length - 8} more (filter by label \`decision\` / \`needs-user\`)`);
  }
  out.push("");

  // Activity
  out.push(`## Last ${hours} hours`, "");
  let any = false;
  for (const p of projects) {
    const lines: string[] = [];
    let created = 0, done = 0;
    for (const t of p.tickets) {
      for (const e of logEntries(t)) {
        if (e.at < since || e.at > now) continue;
        if (e.note === "created") {
          created++;
          lines.push(`- new ${t.id} ${t.title} _(${shortActor(e.actor)})_`);
        } else {
          if (/status → done/.test(e.note)) done++;
          lines.push(`- ${t.id} ${e.note} _(${shortActor(e.actor)})_`);
        }
      }
    }
    if (!lines.length) continue;
    any = true;
    const counts = [created && `${created} new`, done && `${done} done`, `${lines.length - created} updates`].filter(Boolean);
    out.push(`**${p.name}** — ${counts.join(", ")}`);
    out.push(...lines.slice(0, 12));
    if (lines.length > 12) out.push(`- …${lines.length - 12} more`);
    out.push("");
  }
  if (!any) out.push("No ticket activity.", "");

  // In progress
  const doing = open.filter((t) => t.status === "doing").sort(byPrio);
  out.push("## In progress", "");
  if (doing.length) {
    for (const t of doing) {
      const last = new Date(t.updated);
      const stale = now.getTime() - last.getTime() > 3 * 86_400_000;
      out.push(`- ${ref(t)} — ${t.session ? `session ${shortActor(t.session)}, ` : ""}updated ${ago(last, now)}${stale ? " ⚠ stale" : ""}`);
    }
  } else out.push("No ticket is being worked on.");
  out.push("");

  // Priorities
  const top = open.filter((t) => t.status === "todo" && (t.priority === "P0" || t.priority === "P1")).sort(byPrio);
  out.push("## Top priorities", "");
  if (top.length) for (const t of top.slice(0, 10)) out.push(`- ${t.priority} ${ref(t)}`);
  else out.push("No P0/P1 tickets waiting.");
  if (top.length > 10) out.push(`- …and ${top.length - 10} more`);
  out.push("");

  // Totals
  out.push("## By project", "", "| Project | To do | Doing | Review | Done |", "|---|---:|---:|---:|---:|");
  for (const p of projects) {
    const c = (s: string) => p.tickets.filter((t) => t.status === s && !t.archived).length;
    if (c("todo") + c("doing") + c("review") + c("done") === 0) continue;
    out.push(`| ${p.name} | ${c("todo")} | ${c("doing")} | ${c("review")} | ${c("done")} |`);
  }
  out.push("");
  return out.join("\n");
}
