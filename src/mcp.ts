#!/usr/bin/env node
// ticketdeck-mcp: the agent side of TicketDeck, an MCP server over stdio. Registered once for
// the user (`ticketdeck setup`), so it runs in every session wherever it was started; each
// call works out which project it is about (see projects.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  PRIORITIES, TYPES, Store, TicketError, currentSession, registerProject, summaryLine, type Ticket,
} from "./core.js";
import { describeKnown, isRepo, knownProjects, pickProject } from "./projects.js";

const session = currentSession();
const actor = session ?? "agent";
/** The project this session last worked with; the fallback when a call names none. */
let lastProject: string | null = null;

export const INSTRUCTIONS = `TicketDeck keeps each project's tickets as markdown in <project>/.tickets/, so work found in one conversation gets done in a later one. The user follows them on a board and closes them.

Which project: sessions are often started in a parent folder (e.g. ~/projects) while working on one project inside it. Pass \`project\` (its folder name, e.g. "TabStack", or a path) whenever the session folder is not the project itself; after that, calls without \`project\` stay on the same project. \`files\` paths also identify it. ticket_list with no project, outside a project, lists every project's tickets.

When to use the tools:
- First thing on any task that will change a project's files — before reading code or editing — call ticket_list for that project. Use the tool even if you can see .tickets/ on disk: only the tool shows which session holds what, and only ticket_claim tells other sessions you are on it.
- If a ticket covers the task, or the part you are about to do, ticket_claim it before your first edit; if another session holds it, leave it alone and tell the user. Read and change tickets only through these tools, never by opening or editing .tickets/ files.
- When you notice something outside the current task worth doing later (a bug, a missing test, a refactor, a follow-up), ticket_create it in the project it belongs to instead of fixing it on the side. Body: the context you have now, and acceptance criteria as a "- [ ]" checklist.
- When the user says "later", "note that", "add a ticket" or similar, create a ticket.
- Before you finish a task, file a ticket for whatever you are leaving behind: a part you could not fix, a limitation or trade-off you chose to accept ("I left it"), a workaround that should be revisited, or a follow-up you mention to the user. Saying it in your reply is not enough — the reply ends with the conversation; the ticket is what gets picked up later. Mention the ticket id in your reply.
- A plan with more than three independent steps may become tickets linked by depends_on. No tickets for things you will finish in the next few minutes, and none for read-only questions.
- At milestones, ticket_log one line on the ticket you are working on. When finished, set status "review"; never "done" — the user closes tickets.
- If ticket_create reports similar tickets, update or log on one of those, or pass force: true only if yours really differs.`;

const server = new McpServer({ name: "ticketdeck", version: "0.2.0" }, { instructions: INSTRUCTIONS });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

interface Ctx {
  store: Store;
  name: string;
  /** Prefix for lines that name tickets: "[TabStack] ". */
  tag: string;
}

/**
 * Runs a tool against the project the call is about. `create` lets a ticket be filed in a
 * repository that has no .tickets/ yet, when the agent named it or pointed at its files.
 */
function run(input: { project?: string; files?: string[] }, fn: (ctx: Ctx) => string, opts: { create?: boolean } = {}): Result {
  try {
    const picked = pickProject(input, lastProject);
    if (!picked)
      throw new TicketError(
        `Which project? This session runs in ${process.cwd()}, which has no tickets. Pass \`project\`. ${describeKnown()}`,
      );
    const { store, via } = picked;
    let note = "";
    if (!store.initialized) {
      const explicit = via === "project" || via === "files";
      if (!(opts.create && explicit && isRepo(store.root)))
        throw new TicketError(
          `${store.root} has no tickets yet.` +
            (opts.create ? " Tickets can only be created in a git repository." : "") +
            ` ${describeKnown()}`,
        );
      store.init();
      note = `(started .tickets/ in ${store.root})\n`;
    }
    lastProject = store.root;
    registerProject(store.root);
    const name = path.basename(store.root);
    return { content: [{ type: "text", text: note + fn({ store, name, tag: `[${name}] ` }) }] };
  } catch (e) {
    if (e instanceof TicketError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

const err = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

const project = z.string().optional().describe(
  'Project folder name (e.g. "TabStack") or path. Needed when the session folder is not the project; ' +
    "otherwise taken from `files`, the session folder, or the project used last.",
);
const id = z.string().describe('Ticket id, e.g. "T-0007" (or just 7). Ids are per project.');
const list = (what: string) => z.array(z.string()).optional().describe(what);
const line = (ctx: Ctx, t: Ticket) => ctx.tag + summaryLine(t);

server.registerTool(
  "ticket_list",
  {
    description:
      "List tickets, one line each: project, id, status, priority, type, title, claiming session. " +
      "Open ones (todo, doing, review) unless asked otherwise. Without a project and outside one, lists all projects.",
    inputSchema: {
      project,
      status: z.array(z.enum(["todo", "doing", "review", "done", "dropped"])).optional().describe("Only these statuses."),
      label: z.string().optional(),
      mine: z.boolean().optional().describe("Only tickets claimed by this session."),
      include_closed: z.boolean().optional().describe("Also done, dropped and archived tickets."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ project, status, label, mine, include_closed }) => {
    const filter = {
      status, label, includeClosed: include_closed,
      session: mine ? (session ?? "\0none") : undefined,
    };
    const here = Store.open();
    if (!project && !here.initialized) {
      // Outside any project: everything, grouped, so the agent can find where work lives.
      const projects = knownProjects();
      if (!projects.length) return err(`No project has tickets yet. ${describeKnown()}`);
      const out: string[] = [];
      for (const root of projects) {
        const tickets = new Store(root).list(filter);
        out.push(`${path.basename(root)} (${root}):${tickets.length ? "" : " no matching tickets"}`);
        for (const t of tickets) out.push("  " + summaryLine(t));
      }
      out.push('\nPass project: "<name>" to the other ticket tools.');
      return { content: [{ type: "text", text: out.join("\n") }] };
    }
    return run({ project }, (ctx) => {
      const tickets = ctx.store.list(filter);
      const lines = tickets.length ? tickets.map((t) => line(ctx, t)) : [`${ctx.tag}No matching tickets.`];
      if (session) lines.push(`\n(you are session ${session})`);
      return lines.join("\n");
    });
  },
);

server.registerTool(
  "ticket_get",
  {
    description: "Read one ticket in full: its fields, description, acceptance criteria and log.",
    inputSchema: { project, id },
    annotations: { readOnlyHint: true },
  },
  ({ project, id }) => run({ project }, (ctx) => `${ctx.tag}${ctx.store.root}\n` + fs.readFileSync(ctx.store.get(id).path, "utf8")),
);

server.registerTool(
  "ticket_create",
  {
    description:
      "Create a ticket for work to do later, in the project it belongs to. Checks for similar open tickets " +
      "first and, if any, returns them instead (pass force: true if yours really differs). A git repository " +
      "without tickets yet gets a .tickets/ folder.",
    inputSchema: {
      project,
      title: z.string().describe("Short, specific; what is wrong or what to build."),
      body: z.string().describe(
        "Markdown: context (where you found it, why it matters) and acceptance criteria as a '- [ ]' checklist.",
      ),
      type: z.enum(TYPES).optional().describe("Default feature."),
      priority: z.enum(PRIORITIES).optional().describe("P0 urgent … P3 someday. Default P2."),
      labels: list("Short tags, e.g. area names."),
      depends_on: list("Ids of tickets in the same project that must be done first."),
      files: list("Paths involved: relative to the project, or absolute. Also identify the project."),
      force: z.boolean().optional().describe("Create even if similar tickets exist."),
    },
  },
  ({ project, files, ...input }) =>
    run(
      { project, files },
      (ctx) => {
        const r = ctx.store.create({ ...input, files: files?.map((f) => relativeTo(ctx.store.root, f)) }, actor);
        if (r.duplicates)
          return (
            `Not created; these open tickets in ${ctx.name} look similar:\n` +
            r.duplicates.map((t) => line(ctx, t)).join("\n") +
            "\nUpdate or log on one of them, or call again with force: true."
          );
        return `Created ${line(ctx, r.ticket!)}`;
      },
      { create: true },
    ),
);

server.registerTool(
  "ticket_update",
  {
    description:
      "Change a ticket's fields or status; the change is recorded in its log. Status cannot be set " +
      "to done: set review when finished and the user closes it.",
    inputSchema: {
      project,
      id,
      status: z.enum(["todo", "doing", "review", "dropped"]).optional(),
      title: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      type: z.enum(TYPES).optional(),
      labels: list("Replaces the labels."),
      depends_on: list("Replaces the dependencies."),
      files: list("Replaces the file list."),
      release: z.boolean().optional().describe("Clear the claiming session (e.g. when handing back to todo)."),
      note: z.string().optional().describe("Why; appended to the log with the change."),
    },
  },
  ({ project, id, release, files, ...patch }) =>
    run({ project }, (ctx) =>
      line(ctx, ctx.store.update(id, {
        ...patch,
        files: files?.map((f) => relativeTo(ctx.store.root, f)),
        ...(release ? { session: null } : {}),
      }, actor)),
    ),
);

server.registerTool(
  "ticket_claim",
  {
    description: "Claim a ticket for this session: sets it to doing and records the session, so others see who has it.",
    inputSchema: { project, id },
  },
  ({ project, id }) =>
    run({ project }, (ctx) => {
      const t = ctx.store.get(id);
      if (t.session && t.session !== session && t.status === "doing")
        return `${ctx.tag}${t.id} is already being worked on by session ${t.session}. Leave it, or ask the user before taking it over.`;
      return line(ctx, ctx.store.claim(id, session ?? "agent", actor));
    }),
);

server.registerTool(
  "ticket_log",
  {
    description:
      "Append one line of progress to a ticket's log. Logging work on an unclaimed todo ticket claims it for this session.",
    inputSchema: { project, id, note: z.string() },
  },
  ({ project, id, note }) =>
    run({ project }, (ctx) => {
      // Progress on a ticket nobody holds means this session is working on it: claim it, so
      // the board and other sessions see who has it even if the agent skipped ticket_claim.
      const t = ctx.store.get(id);
      if (t.status === "todo" && !t.session && session) {
        ctx.store.claim(id, session, actor);
        return line(ctx, ctx.store.log(id, note, actor)) + "\n(claimed for this session, since you are working on it)";
      }
      return line(ctx, ctx.store.log(id, note, actor));
    }),
);

/** Stores paths relative to the project when they are inside it. */
function relativeTo(root: string, f: string): string {
  const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
  const rel = path.relative(root, abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(abs)) return rel;
  return f;
}

await server.connect(new StdioServerTransport());
