# TicketDeck

Tickets your coding agent creates and manages itself, stored as markdown in your repo.
Design: [docs/DESIGN.md](docs/DESIGN.md).

Status: **M2** — core library, CLI, MCP server (multi-project), a `⌃⌥T` panel in
[TabStack](https://github.com/MuqiuPeng/TabStack) and a web board.

## Setup

```bash
npm install && npm run build
npm link            # optional: puts `ticketdeck` on your PATH
```

Once, for every Claude session wherever it is started:

```bash
ticketdeck setup --root ~/projects --root ~/working
```

`setup` registers the `ticketdeck` MCP server at user scope (`claude mcp add --scope user`)
and records the folders whose sub-folders are projects. The agent rules travel in the
server's instructions, so no per-project config is needed.

Optionally, in a project (agents also start `.tickets/` themselves in a git repo the first
time they file a ticket there):

```bash
cd ~/projects/SomeProject
ticketdeck init     # .tickets/ plus a short pointer in CLAUDE.md; --mcp also writes .mcp.json
```

## Which project a call is about

Sessions are often started in a parent folder (`~/projects`) while working on one project.
Every tool takes an optional `project` (folder name, case-insensitive, or a path) and
otherwise picks, in order: the project the `files` paths are in, the session folder if it
has tickets, the project this session used last. `ticket_list` with none of these lists
every project. Output lines are tagged `[Project]`.

## How it works

- One file per ticket: `.tickets/T-0007-short-title.md`, YAML frontmatter plus markdown
  body ending in an append-only `## Log`.
- Status: `todo → doing → review → done`, or `dropped`. Agents can go as far as
  `review`; only you set `done`.
- Inside a git worktree the tickets of the **main checkout** are used, so parallel
  sessions in different worktrees share one set.
- Agents are identified by `CLAUDE_CODE_HOST_SESSION_ID` (Claude desktop's `local_…`
  session id) or `CLAUDE_CODE_SESSION_ID`; claims and log lines record it.
- Writers take a short lock (`.tickets/.lock`), so concurrent sessions never share an id.
- Closed tickets untouched for 14 days move to `.tickets/archive/`
  (`archiveAfterDays` in `.tickets/config.json`).
- Every project used is recorded in `~/.ticketdeck/projects.json` for the board.

## Looking at tickets

- **TabStack, `⌃⌥T`**: a floating panel with the current workspace's tickets (`Tab` for all
  projects). `↩` switches to the project's workspace with Claude on the ticket's session,
  `⌘D` marks done, `⌘R` back to todo, checklist items tick in place. TabStack drives the
  CLI (`ticketdeck state` / `set` / `check`), found through `~/.ticketdeck/cli.json`, which
  `ticketdeck setup` writes.
- **Web board, `ticketdeck serve [--open]`**: `http://localhost:4477`, columns by status
  across every project, drag to change status, filters (kept in the URL, so a project's
  board can be a bookmark or a TabStack tab), detail drawer with checklist, log note,
  links to the Claude session and to files in VS Code, and a notification when a ticket
  reaches review. Updates live from file changes. Listens on 127.0.0.1 only and refuses
  other Host/Origin headers.

## Daily report

`ticketdeck report --save` writes a markdown digest of every project to
`~/.ticketdeck/reports/<date>.md`: what needs you (tickets in review, decisions and actions
waiting on you), the last 24 hours of activity, work in progress (stale after 3 days), top
priorities and per-project counts. A Claude scheduled task (`ticketdeck-daily-report`, 8:00
daily) runs it, then adds a summary and the unfinished work of yesterday's sessions that no
ticket covers. Read it in TabStack's ⌃⌥T panel (Tab to **Report**, ←→ for other days) or on
the board (**Daily report**, `R`).

## MCP tools

| Tool | |
|---|---|
| `ticket_list` | open tickets, one line each; `status`, `label`, `mine`, `include_closed`; all projects when none applies |
| `ticket_get` | the whole ticket file |
| `ticket_create` | refuses and lists look-alikes unless `force: true` |
| `ticket_update` | fields/status (not `done`); `release` drops the claim; `note` goes in the log |
| `ticket_claim` | `doing` + this session; refuses if another session is on it |
| `ticket_log` | one line of progress |

## CLI

```
ticketdeck list [-a] [-s status,...] [-l label]
ticketdeck new "title" [-t type] [-p priority] [-l label]... [-b body]   (body also from stdin)
ticketdeck show <id>
ticketdeck set <id> key=value...
ticketdeck log <id> "note"
ticketdeck done <id>
ticketdeck check <id> <n> [on|off]
ticketdeck state [--closed]            JSON, for TabStack
ticketdeck serve [--port 4477] [--open]
ticketdeck report [--save] [--hours 24]
ticketdeck reports [--show <date>]
ticketdeck projects
```

## Development

```bash
npm test            # builds, then runs node:test (core, CLI, MCP over stdio)
```
