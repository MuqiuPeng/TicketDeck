// Daily report: a short, structured digest of every project's tickets, kept in
// ~/.ticketdeck/reports/<YYYY-MM-DD>.json. `ticketdeck report --save` writes the facts; the
// 8:00 scheduled Claude task then adds a summary and what yesterday's sessions left untracked
// (`ticketdeck report annotate`). TabStack's ⌃⌥T panel and the web board draw it themselves.

import * as fs from "node:fs";
import * as path from "node:path";
import { LOG_HEADINGS, Store, TicketError, shortActor, ticketdeckHome, type Ticket } from "./core.js";
import { knownProjects } from "./projects.js";

export interface ReportItem {
  project: string;
  root: string;
  id: string;
  title: string;
  priority: string;
  /** ISO time of the ticket's last update. */
  updated: string;
  session?: string | null;
  stale?: boolean;
}

/** One of today's (up to three) focus items. */
export interface FocusItem extends ReportItem {
  /** review = 待验收, decision = 待决策, action = 需你执行, push = 优先推进 */
  kind: "review" | "decision" | "action" | "push";
  /** Whole days since the ticket last changed. */
  idleDays: number;
  /** Why it is today's focus, one short Chinese phrase (from the scheduled task). */
  reason?: string;
}

export interface Leftover {
  project: string;
  task: string;
  session?: string;
  evidence?: string;
}

/** A task the plan suggests handing to a new session, mostly tidying up tickets. */
export interface Proposal {
  /** p1, p2, … within the report. */
  id: string;
  project: string;
  root: string;
  /** What to do, one short Chinese line written like a ticket title. */
  title: string;
  /** Why it is worth doing now, one short Chinese phrase. */
  why?: string;
  /** Tickets it concerns (ids in the project). */
  tickets?: string[];
  /** The instructions for the new session, in Chinese. */
  prompt: string;
}

export interface Report {
  version: 2;
  date: string;
  generatedAt: string;
  hours: number;
  totals: { open: number; review: number; doing: number; todo: number; decisions: number; done: number; stale: number; projects: number };
  /** Two or three sentences, written by the scheduled task; null until then. */
  summary: string | null;
  /** 今日重点: at most three, in order. */
  focus: FocusItem[];
  review: ReportItem[];
  decisions: ReportItem[];
  doing: ReportItem[];
  priorities: ReportItem[];
  activity: { project: string; root: string; created: number; done: number; updated: number }[];
  /** Unfinished work from yesterday's sessions that no ticket covers; null until the task runs. */
  leftovers: Leftover[] | null;
  /** 提议执行: tasks to start in a new session if the user agrees; null until written. */
  proposals?: Proposal[] | null;
}

export function reportsDir(): string {
  return path.join(ticketdeckHome(), "reports");
}

export function listReports(): string[] {
  try {
    return fs
      .readdirSync(reportsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function readReport(date: string): Report | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(reportsDir(), `${date}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function saveReport(r: Report): string {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const file = path.join(reportsDir(), `${r.date}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

/** Adds the scheduled task's summary and leftovers to a saved report. */
export function annotateReport(
  date: string,
  summary: string | undefined,
  leftovers: Leftover[] | undefined,
  focus?: { project: string; id: string; reason?: string }[],
  proposals?: Omit<Proposal, "id" | "root">[],
): Report {
  const r = readReport(date);
  if (!r) throw new TicketError(`No report for ${date}; run \`ticketdeck report --save\` first.`);
  if (proposals) r.proposals = proposals.slice(0, MAX_PROPOSALS).map((p, i) => proposal(p, i));
  if (focus) r.focus = focus.slice(0, 3).map((f) => focusItem(f.project, f.id, f.reason));
  if (summary !== undefined) r.summary = summary.trim() || null;
  if (leftovers !== undefined) r.leftovers = leftovers;
  saveReport(r);
  return r;
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The "## Log" lines of a ticket: "- 2026-11-09 11:40 · actor · note". */
function logEntries(t: Ticket): { at: Date; note: string }[] {
  const i = Math.max(...LOG_HEADINGS.map((h) => t.body.indexOf(h)));
  if (i < 0) return [];
  const out: { at: Date; note: string }[] = [];
  for (const line of t.body.slice(i).split("\n")) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · .+? · (.*)$/);
    if (m) out.push({ at: new Date(`${m[1]}T${m[2]}:00`), note: m[3] });
  }
  return out;
}

const PRIO: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const DAY = 86_400_000;

function kindOf(t: Ticket): FocusItem["kind"] {
  if (t.status === "review") return "review";
  if (t.labels.includes("decision")) return "decision";
  if (t.labels.includes("needs-user")) return "action";
  return "push";
}

/** A focus item for a ticket named by project (folder name) and id, as the task passes them. */
function focusItem(project: string, id: string, reason?: string): FocusItem {
  const root = knownProjects().find((p) => path.basename(p).toLowerCase() === project.toLowerCase());
  if (!root) throw new TicketError(`--focus: no project "${project}".`);
  const t = new Store(root).get(id);
  return {
    project: path.basename(root), root, id: t.id, title: t.title, priority: t.priority, updated: t.updated,
    ...(t.session ? { session: t.session } : {}),
    kind: kindOf(t),
    idleDays: Math.max(0, Math.floor((Date.now() - Date.parse(t.updated)) / DAY)),
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}
const LIMIT = 5;
const MAX_PROPOSALS = 5;

/** Checks a proposal as the task passes it and adds its id and project folder. */
function proposal(p: Omit<Proposal, "id" | "root">, i: number): Proposal {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const project = text(p.project), title = text(p.title), prompt = text(p.prompt), why = text(p.why);
  if (!project || !title || !prompt) throw new TicketError(`proposal ${i + 1} needs project, title and prompt.`);
  const root = knownProjects().find((r) => path.basename(r).toLowerCase() === project.toLowerCase());
  if (!root) throw new TicketError(`proposal ${i + 1}: no project "${project}".`);
  const tickets = Array.isArray(p.tickets) ? p.tickets.map(text).filter(Boolean) : [];
  return {
    id: `p${i + 1}`, project: path.basename(root), root, title, prompt,
    ...(why ? { why } : {}), ...(tickets.length ? { tickets } : {}),
  };
}

/** The facts for the `hours` before `now`; summary and leftovers are left for the task. */
export function buildReport(now = new Date(), hours = 24): Report {
  const since = now.getTime() - hours * 3_600_000;
  const projects = knownProjects().map((root) => ({
    name: path.basename(root),
    root,
    tickets: new Store(root).list({ includeClosed: true }).filter((t) => !t.archived),
  }));
  const item = (p: { name: string; root: string }, t: Ticket): ReportItem => ({
    project: p.name, root: p.root, id: t.id, title: t.title, priority: t.priority, updated: t.updated,
    ...(t.session ? { session: t.session } : {}),
  });
  const all = projects.flatMap((p) => p.tickets.map((t) => ({ p, t })));
  const byPrio = (a: { t: Ticket }, b: { t: Ticket }) => PRIO[a.t.priority] - PRIO[b.t.priority] || b.t.updated.localeCompare(a.t.updated);
  const isOpen = (t: Ticket) => t.status === "todo" || t.status === "doing" || t.status === "review";

  const review = all.filter(({ t }) => t.status === "review").sort(byPrio);
  const doing = all.filter(({ t }) => t.status === "doing").sort(byPrio);
  const decisions = all
    .filter(({ t }) => t.status === "todo" && t.labels.some((l) => l === "decision" || l === "needs-user"))
    .sort(byPrio);
  const priorities = all
    .filter(({ t }) => t.status === "todo" && PRIO[t.priority] <= 1 && !t.labels.some((l) => l === "decision" || l === "needs-user"))
    .sort(byPrio);
  const staleAt = now.getTime() - 3 * 86_400_000;

  const activity = projects
    .map((p) => {
      let created = 0, done = 0, updated = 0;
      for (const t of p.tickets)
        for (const e of logEntries(t)) {
          const at = e.at.getTime();
          if (at < since || at > now.getTime()) continue;
          if (e.note === "created" || e.note === "创建") created++;
          else if (/(status → done|状态 → 已完成)/.test(e.note)) done++;
          else updated++;
        }
      return { project: p.name, root: p.root, created, done, updated };
    })
    .filter((a) => a.created + a.done + a.updated > 0)
    .sort((a, b) => b.done + b.updated + b.created - (a.done + a.updated + a.created));

  // 今日重点 without the task's judgement: what waits for acceptance, then decisions and
  // actions on the user, then the most urgent work, the longest-idle first within a tier.
  const idle = (t: Ticket) => Math.max(0, Math.floor((now.getTime() - Date.parse(t.updated)) / DAY));
  const tier = (t: Ticket) =>
    t.status === "review" ? 0 : kindOf(t) !== "push" && PRIO[t.priority] <= 2 ? 1 + PRIO[t.priority] : 10 + PRIO[t.priority];
  const focus = all
    .filter(({ t }) => t.status === "review" || (t.status === "todo" && (kindOf(t) !== "push" ? PRIO[t.priority] <= 2 : PRIO[t.priority] <= 1)))
    .sort((a, b) => tier(a.t) - tier(b.t) || idle(b.t) - idle(a.t))
    .slice(0, 3)
    .map(({ p, t }) => ({ ...item(p, t), kind: kindOf(t), idleDays: idle(t) }));

  const doingItems = doing.map(({ p, t }) => ({ ...item(p, t), stale: Date.parse(t.updated) < staleAt }));
  const open = all.filter(({ t }) => isOpen(t));
  return {
    version: 2,
    date: localDate(now),
    generatedAt: now.toISOString(),
    hours,
    totals: {
      open: open.length,
      review: review.length,
      doing: doing.length,
      todo: all.filter(({ t }) => t.status === "todo").length,
      decisions: decisions.length,
      done: activity.reduce((n, a) => n + a.done, 0),
      stale: doingItems.filter((d) => d.stale).length,
      projects: new Set(open.map(({ p }) => p.root)).size,
    },
    summary: null,
    focus,
    review: review.map(({ p, t }) => item(p, t)),
    decisions: decisions.slice(0, LIMIT).map(({ p, t }) => item(p, t)),
    doing: doingItems,
    priorities: priorities.slice(0, LIMIT).map(({ p, t }) => item(p, t)),
    activity,
    leftovers: null,
    proposals: null,
  };
}

/**
 * How to write 提议执行, printed by `ticketdeck report guide`. The 8:00 task and a session the
 * user starts from TabStack both follow it, so the rules live in one place.
 */
export const PROPOSAL_GUIDE = `Write 提议执行 (proposals) for today's TicketDeck plan: up to ${MAX_PROPOSALS} tasks that tidy up
the user's tickets and repositories. The user reads them in TabStack's ⌃⌥T panel; "执行" opens a new
Claude Code session in the project with your prompt filled in, so each proposal must be a job one
session can finish in one project without asking the user to decide anything.

Gather (read only — do not change tickets or repositories here):
- \`ticketdeck state\` for every project's tickets, \`ticketdeck report\` for today's plan.
- For projects with open tickets: \`git -C <root> status --short\`, \`git -C <root> log --oneline -15\`,
  \`git -C <root> branch --merged\` and, when a GitHub remote exists, \`gh pr list --state all -L 10\`.

Good proposals, most useful first:
1. Open tickets whose work looks done (a commit, merged PR or branch says so): verify, then set review.
2. Duplicate or overlapping tickets: merge them into one, drop the rest with a note.
3. Tickets idle for 14+ days at P2/P3: check whether they still apply; update, re-prioritise or drop.
4. 待纳入计划 items in today's plan that no ticket covers: create the tickets.
5. Repository leftovers: uncommitted changes, branches already merged, stale worktrees — tidy them up
   (commit or ticket the changes; delete only branches that are merged).
Leave out: product or design decisions, anything needing credentials or money, today's 今日重点,
tickets another session holds (status doing), and anything already proposed today unless it changed.

Each proposal is a JSON object:
  {"project": "<folder name>", "title": "<中文，像任务标题，≤ 25 字>", "why": "<中文理由，≤ 15 字>",
   "tickets": ["T-0003", ...], "prompt": "<给新会话的中文说明>"}
The prompt stands alone (the new session knows nothing else): what to check, what to do, how to know it
is done; say to use the TicketDeck tools for tickets (claim first, set review — never done), not to push
or delete anything unmerged without asking, and to finish with a one-line summary.

Write them all at once (this replaces today's proposals), from a file because prompts are long:
  ticketdeck report annotate --proposals @<file.json>
If nothing is worth proposing, run \`ticketdeck report annotate --no-proposals\`.
All text the user sees is Simplified Chinese; keep code, paths, ids and branch names as they are.`;

/** A short plain rendering for the terminal (`ticketdeck report`). */
export const KIND_LABEL: Record<FocusItem["kind"], string> = { review: "待验收", decision: "待决策", action: "需你执行", push: "优先推进" };

export function reportText(r: Report): string {
  const line = (i: ReportItem) => `  ${i.project} ${i.id} ${i.title}`;
  const parts = [r.totals.done && `昨日完成 ${r.totals.done} 项`, r.totals.review && `${r.totals.review} 项待验收`, r.totals.stale && `${r.totals.stale} 项停滞`].filter(Boolean);
  const out = [`今日计划 · ${r.date}`, parts.join(" · ") || `${r.totals.open} 项进行中的任务`];
  if (r.summary) out.push("", r.summary);
  if (r.focus?.length) {
    out.push("", "今日重点");
    r.focus.forEach((f, i) =>
      out.push(`  ${i + 1}. [${KIND_LABEL[f.kind]}] ${f.project} · ${f.title}${f.idleDays >= 2 ? `（${f.idleDays} 天未推进）` : ""}${f.reason ? `\n     ${f.reason}` : ""}`),
    );
  }
  if (r.activity.length) out.push("", `昨日进展 · ${r.activity.length} 个项目`, ...r.activity.slice(0, 6).map((a) => `  ${a.project}  新增 ${a.created} · 完成 ${a.done} · 更新 ${a.updated}`));
  if (r.doing.length) out.push("", `进行中 · ${r.doing.length} 项`, ...r.doing.map((i) => line(i) + (i.stale ? "  （停滞）" : "")));
  if (r.totals.decisions) out.push("", `待决策与待执行 · ${r.totals.decisions} 项`, ...r.decisions.map(line));
  if (r.proposals?.length)
    out.push("", `提议执行 · ${r.proposals.length} 项（同意后开新会话处理）`, ...r.proposals.map((p) => `  ${p.id} ${p.project} ${p.title}${p.why ? `  — ${p.why}` : ""}`));
  if (r.leftovers?.length) out.push("", `待纳入计划 · ${r.leftovers.length} 项（来自会话，尚未建任务）`, ...r.leftovers.map((l) => `  ${l.project} ${l.task}`));
  return out.join("\n") + "\n";
}
