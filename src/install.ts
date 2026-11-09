// `ticketdeck setup` registers the MCP server for the user (every session, wherever it runs);
// `ticketdeck init` starts .tickets/ in a project and can add a pointer to CLAUDE.md.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- ticketdeck:start -->";
const END = "<!-- ticketdeck:end -->";

export const RULES = `${START}
## Tickets

This project's tickets live in \`.tickets/\` and are managed with the TicketDeck \`ticket_*\` tools;
follow the TicketDeck server's instructions. Check \`ticket_list\` before starting work here.
${END}`;

/** Adds or refreshes the TicketDeck section of CLAUDE.md. Returns what happened. */
export function installRules(root: string): "created" | "updated" | "added" | "unchanged" {
  const file = path.join(root, "CLAUDE.md");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, RULES + "\n");
    return "created";
  }
  const text = fs.readFileSync(file, "utf8");
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s >= 0 && e > s) {
    const next = text.slice(0, s) + RULES + text.slice(e + END.length);
    if (next === text) return "unchanged";
    fs.writeFileSync(file, next);
    return "updated";
  }
  fs.writeFileSync(file, text.replace(/\s*$/, "") + "\n\n" + RULES + "\n");
  return "added";
}

/** Path of the MCP server entry point next to this file (dist/mcp.js). */
export function mcpEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
}

/** Adds the ticketdeck server to the project's .mcp.json, keeping any other servers. */
export function installMcp(root: string): "created" | "updated" | "unchanged" {
  const file = path.join(root, ".mcp.json");
  let data: { mcpServers?: Record<string, unknown> } = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON; fix it or add the ticketdeck server by hand.`);
    }
  }
  const entry = { command: process.execPath, args: [mcpEntry()] };
  data.mcpServers ??= {};
  if (JSON.stringify(data.mcpServers.ticketdeck) === JSON.stringify(entry)) return "unchanged";
  data.mcpServers.ticketdeck = entry;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return existed ? "updated" : "created";
}

/** The `claude` CLI: the one this process runs under, else whatever is on PATH. */
export function claudeBinary(): string | null {
  const candidates = [process.env.CLAUDE_CODE_EXECPATH, "claude"].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

/**
 * Registers ticketdeck as a user-scope MCP server through `claude mcp`, replacing an older
 * registration. Returns the command to run by hand when the CLI is not found.
 */
export function installGlobalMcp(): { ok: true } | { ok: false; command: string } {
  const args = ["mcp", "add", "--scope", "user", "ticketdeck", "--", process.execPath, mcpEntry()];
  const claude = claudeBinary();
  if (!claude) return { ok: false, command: ["claude", ...args].map(shellQuote).join(" ") };
  try {
    execFileSync(claude, ["mcp", "remove", "--scope", "user", "ticketdeck"], { stdio: "ignore" });
  } catch {}
  execFileSync(claude, args, { stdio: "ignore" });
  return { ok: true };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
