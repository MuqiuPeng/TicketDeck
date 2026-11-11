// 提议执行 on demand: runs Claude Code headless (`claude -p`) to write today's proposals by
// `ticketdeck report guide`, allowed only to read tickets and repositories and to write the
// proposals through this CLI. TabStack's ⌃⌥T panel and the web board start it with
// `ticketdeck report propose --background`; its state is a small file next to the report,
// so every viewer sees the same "生成中" and the same error.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TicketError } from "./core.js";
import { listReports, localDate, reportsDir } from "./report.js";

export interface ProposeJob {
  state: "running" | "done" | "failed";
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  /** Chinese, for the user. */
  error?: string;
  /** The run's last line, e.g. how many proposals it wrote. */
  result?: string;
}

const TIMEOUT_MS = 8 * 60_000;

function jobFile(date: string): string {
  return path.join(reportsDir(), `${date}.propose.json`);
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The latest run for a date; a "running" one whose process is gone counts as failed. */
export function readJob(date: string): ProposeJob | null {
  try {
    const job = JSON.parse(fs.readFileSync(jobFile(date), "utf8")) as ProposeJob;
    if (job.state === "running" && !alive(job.pid)) return { ...job, state: "failed", error: "生成中断了，可以重试。" };
    return job;
  } catch {
    return null;
  }
}

function writeJob(date: string, job: ProposeJob): void {
  fs.mkdirSync(reportsDir(), { recursive: true });
  const tmp = `${jobFile(date)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  fs.renameSync(tmp, jobFile(date));
}

/** Where Claude Code's CLI is: TICKETDECK_CLAUDE, else the usual install places. */
export function claudeBinary(): string | null {
  const home = os.homedir();
  const candidates = [process.env.TICKETDECK_CLAUDE, `${home}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", `${home}/.claude/local/claude`];
  return candidates.find((c) => !!c && fs.existsSync(c)) ?? null;
}

function cliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/** Starts a run in a detached process and returns at once. */
export function startPropose(date = localDate()): ProposeJob {
  const job = readJob(date);
  if (job?.state === "running") return job;
  if (!claudeBinary()) throw new TicketError("没找到 Claude Code 命令行（claude）。安装后再试：https://claude.com/claude-code");
  const child = spawn(process.execPath, [cliPath(), "report", "propose", "--date", date], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const started: ProposeJob = { state: "running", pid: child.pid, startedAt: new Date().toISOString() };
  writeJob(date, started);
  return started;
}

/** Runs to the end in this process (the detached child does this). */
export async function runPropose(date = localDate()): Promise<ProposeJob> {
  const claude = claudeBinary();
  const startedAt = new Date().toISOString();
  const fail = (error: string): ProposeJob => {
    const job: ProposeJob = { state: "failed", startedAt, finishedAt: new Date().toISOString(), error };
    writeJob(date, job);
    return job;
  };
  if (!claude) return fail("没找到 Claude Code 命令行（claude）。安装后再试：https://claude.com/claude-code");
  writeJob(date, { state: "running", pid: process.pid, startedAt });

  const td = `${process.execPath} ${cliPath()}`;
  const today = date === localDate();
  const prompt = `为 TicketDeck ${today ? "今天" : date} 的日报生成「提议执行」。这是后台运行，没有人能回答问题，也不要等确认。
下面的 \`ticketdeck\` 一律写成 \`${td}\`（原样照抄这条路径，不要加引号）。
1. 运行 \`ticketdeck reports\`；${today ? "如果最新一份不是今天的，先运行 `ticketdeck report --save`。" : `日报日期是 ${date}。`}
2. 运行 \`ticketdeck report guide\`，按它的说明收集信息、挑出值得清理的任务（只读，不改工单和仓库）。
   今天日报里已有的提议（\`ticketdeck reports --show ${date}\` 或读 ${path.join(reportsDir(), `${date}.json`)}）里，被忽略或已开会话的不要再提。
3. 写入时不要建文件，用 heredoc 从标准输入传 JSON：
   ${td} report annotate --date ${date} --proposals @- <<'JSON'
   [ ... ]
   JSON
   没有值得提议的就运行 \`${td} report annotate --date ${date} --no-proposals\`。
最后用一句中文说写了几条提议。`;
  const allowed = [
    `Bash(${td} state:*)`, `Bash(${td} report:*)`, `Bash(${td} reports:*)`,
    "Bash(git -C:*)", "Bash(gh pr list:*)", "Bash(gh pr view:*)", "Read", "Grep", "Glob",
  ];
  const projects = path.join(os.homedir(), "projects");
  const cwd = fs.existsSync(projects) ? projects : os.homedir();
  const env = {
    ...process.env,
    // Started from an app or a service the PATH is bare; git, gh and node live elsewhere.
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", path.dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(":"),
  };

  return new Promise((resolve) => {
    const p = spawn(
      claude,
      ["-p", prompt, "--allowedTools", ...allowed, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "--max-turns", "60"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => p.kill("SIGTERM"), TIMEOUT_MS);
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve(fail(`启动 claude 失败：${e.message}`));
    });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return resolve(fail(`生成超时（${TIMEOUT_MS / 60_000} 分钟），已停止。`));
      const text = `${err}\n${out}`.trim();
      if (code !== 0) {
        const login = /authenticate|OAuth|\/login/i.test(text);
        return resolve(fail(login ? "Claude Code 命令行没有登录（或登录已过期）。在终端运行 claude，输入 /login 登录后再试。" : `生成失败：${text.slice(-300)}`));
      }
      const job: ProposeJob = { state: "done", startedAt, finishedAt: new Date().toISOString(), result: out.trim().split("\n").pop()?.slice(0, 200) };
      writeJob(date, job);
      resolve(job);
    });
  });
}

/** The date a run is for when none is given: today's report, else the newest. */
export function proposeDate(given?: string): string {
  if (given) return given;
  const today = localDate();
  return listReports().includes(today) ? today : listReports()[0] ?? today;
}
