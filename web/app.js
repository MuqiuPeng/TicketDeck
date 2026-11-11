// TicketDeck board: one page, no build step. State comes from /api/state and is re-fetched
// whenever the server reports a change under any .tickets/ folder (server-sent events).

import { marked } from "/vendor/marked.js";

const COLUMNS = ["todo", "doing", "review", "done", "dropped"];
const NAMES = { todo: "To do", doing: "Doing", review: "Review", done: "Done", dropped: "Dropped" };
const TYPE_NAMES = { bug: "Bug", feature: "Feature", chore: "Chore", idea: "Idea" };

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const view = {
  project: params.get("project") ?? "",
  type: params.get("type") ?? "",
  label: params.get("label") ?? "",
  q: params.get("q") ?? "",
  closed: params.get("closed") === "1",
};
let data = { projects: [], statuses: [], priorities: [], types: [] };
let selected = params.get("ticket"); // "<project path>#<id>"
let reportDate = params.get("report"); // "" = newest, null = closed
let proposalsOpen = params.get("proposals") === "1"; // 提议执行, a drawer of its own
let lastStatus = null; // key → status, to notice tickets reaching review

// Untrusted text: tickets are written by agents. Raw HTML in markdown is shown as text.
marked.use({
  gfm: true,
  renderer: {
    html(token) {
      return esc(typeof token === "string" ? token : token.text);
    },
  },
});

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// MARK: Data

async function load() {
  const res = await fetch(`/api/state${view.closed ? "?closed=1" : ""}`);
  data = await res.json();
  noticeReviews();
  render();
  countProposals();
}

/** The open proposals on today's plan, as a badge on the 提议执行 button. */
async function countProposals() {
  const r = await fetch("/api/report").then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const n = r && r.date === localDay() ? (r.proposals ?? []).filter((p) => !p.status).length : 0;
  const c = $("#proposals-count");
  c.hidden = n === 0;
  c.textContent = n;
}

async function api(route, body) {
  const res = await fetch(`/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) {
    toast(out.error ?? "Something went wrong", true);
    throw new Error(out.error);
  }
  return out;
}

const key = (t) => `${t.project}#${t.id}`;

function allTickets() {
  return data.projects.flatMap((p) => p.tickets.map((t) => ({ ...t, project: p.path, projectName: p.name })));
}

function visible() {
  const q = view.q.trim().toLowerCase();
  return allTickets().filter(
    (t) =>
      (!view.project || t.project === view.project) &&
      (!view.type || t.type === view.type) &&
      (!view.label || t.labels.includes(view.label)) &&
      (!q || [t.id, t.title, t.projectName, ...t.labels].some((s) => s.toLowerCase().includes(q)) ||
        t.body.toLowerCase().includes(q)),
  );
}

function checklist(body) {
  const items = [...body.matchAll(/^\s*[-*+]\s+\[([ xX])\]/gm)];
  return { done: items.filter((m) => m[1] !== " ").length, total: items.length };
}

function ago(ts) {
  const d = (Date.now() - Date.parse(ts)) / 1000;
  if (!isFinite(d)) return "";
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const shortSession = (s) => (s?.startsWith("local_") ? s.slice(0, 14) : s);
const sessionURL = (s) => (s?.startsWith("local_") ? `claude://code/continue?session=${encodeURIComponent(s)}` : null);
const vscodeURL = (p) => `vscode://file${encodeURI(p)}`;

// MARK: Rendering

function render() {
  renderFilters();
  renderBoard();
  renderDetail();
  syncURL();
}

function renderFilters() {
  const opt = (value, label, cur) => h("option", { value, selected: value === cur }, label);
  $("#f-project").replaceChildren(
    opt("", "All projects", view.project),
    ...data.projects.map((p) => opt(p.path, `${p.name} (${p.tickets.filter((t) => t.status !== "done" && t.status !== "dropped").length})`, view.project)),
  );
  $("#f-type").replaceChildren(opt("", "All types", view.type), ...data.types.map((t) => opt(t, TYPE_NAMES[t] ?? t, view.type)));
  const labels = [...new Set(allTickets().flatMap((t) => t.labels))].sort();
  $("#f-label").replaceChildren(opt("", "All labels", view.label), ...labels.map((l) => opt(l, `#${l}`, view.label)));
  if (document.activeElement !== $("#f-search")) $("#f-search").value = view.q;
  $("#f-closed").checked = view.closed;
}

function renderBoard() {
  const tickets = visible();
  const cols = COLUMNS.filter((c) => view.closed || c !== "dropped");
  $("#board").replaceChildren(
    ...cols.map((status) => {
      const list = tickets.filter((t) => t.status === status);
      const col = h(
        "section",
        {
          class: "col",
          dataset: { status, s: status },
          ondragover: (e) => {
            e.preventDefault();
            col.classList.add("drop");
          },
          ondragleave: () => col.classList.remove("drop"),
          ondrop: (e) => {
            e.preventDefault();
            col.classList.remove("drop");
            const k = e.dataTransfer.getData("text/plain");
            const t = allTickets().find((x) => key(x) === k);
            if (t && t.status !== status) setStatus(t, status);
          },
        },
        h("h2", {}, h("span", {}, h("span", { class: "dot" }), NAMES[status]), h("span", { class: "n" }, list.length)),
        h("div", { class: "cards" }, list.length ? list.map(card) : h("div", { class: "empty" }, "—")),
      );
      return col;
    }),
  );
}

function card(t) {
  const c = checklist(t.body);
  return h(
    "article",
    {
      class: `card${key(t) === selected ? " sel" : ""}`,
      draggable: "true",
      dataset: { s: t.status },
      tabindex: "0",
      onclick: () => select(key(t)),
      onkeydown: (e) => e.key === "Enter" && select(key(t)),
      ondragstart: (e) => {
        e.dataTransfer.setData("text/plain", key(t));
        e.currentTarget.classList.add("dragging");
      },
      ondragend: (e) => e.currentTarget.classList.remove("dragging"),
    },
    h(
      "div",
      { class: "top" },
      h("span", { class: "mono" }, t.id),
      !view.project && h("span", { class: "chip proj" }, t.projectName),
      h("span", { class: "prio", dataset: { p: t.priority } }, t.priority),
      h("span", { class: "progress" }, c.total ? `☑ ${c.done}/${c.total}` : ""),
    ),
    h("div", { class: "title" }, t.title),
    h(
      "div",
      { class: "meta" },
      h("span", { class: "chip" }, TYPE_NAMES[t.type] ?? t.type),
      t.labels.map((l) => h("span", { class: "chip" }, `#${l}`)),
      t.session && t.status === "doing" && h("span", { class: "chip live", title: t.session }, "● in a session"),
      t.depends_on.length > 0 && h("span", { class: "chip" }, `needs ${t.depends_on.join(", ")}`),
      h("span", { title: t.updated }, ago(t.updated)),
    ),
  );
}

function renderDetail() {
  const t = allTickets().find((x) => key(x) === selected);
  const pane = $("#detail");
  pane.classList.remove("report");
  if (!t) {
    if (proposalsOpen) return renderProposals();
    if (reportDate != null) return renderReport();
    pane.hidden = true;
    return;
  }
  pane.hidden = false;
  const scroll = pane.scrollTop;
  const dropdown = (name, values, labels, cur) =>
    h(
      "select",
      { onchange: (e) => api("update", { project: t.project, id: t.id, [name]: e.target.value }) },
      values.map((v) => h("option", { value: v, selected: v === cur }, labels[v] ?? v)),
    );
  const url = sessionURL(t.session);
  const body = h("div", { class: "md" });
  body.innerHTML = marked.parse(t.body);
  // Links: only web, mail and in-page; no scripts, no remote images.
  for (const a of body.querySelectorAll("a")) {
    if (!/^(https?:|mailto:|#)/i.test(a.getAttribute("href") ?? "")) a.removeAttribute("href");
    else a.target = "_blank";
  }
  for (const img of body.querySelectorAll("img")) img.replaceWith(img.alt ?? "");
  body.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
    box.disabled = false;
    box.addEventListener("change", () => api("check", { project: t.project, id: t.id, index: i, checked: box.checked }));
  });

  const note = h("input", { placeholder: "Add a progress note…" });
  pane.replaceChildren(
    h(
      "div",
      { class: "head" },
      h("span", { class: "chip proj" }, t.projectName),
      h("span", { class: "mono" }, t.id),
      h("span", { class: "spill", dataset: { s: t.status } }, h("span", { class: "dot" }), NAMES[t.status]),
      t.archived && h("span", { class: "chip" }, "archived"),
      h("button", { class: "ghost x", onclick: () => select(null), title: "Close (Esc)" }, "✕"),
    ),
    h("h1", {}, t.title),
    h(
      "div",
      { class: "btns" },
      url && h("button", { class: "primary", onclick: () => (location.href = url) }, "Open Claude session"),
      t.status !== "done" && h("button", { onclick: () => setStatus(t, "done") }, "✓ Done"),
      t.status !== "todo" && h("button", { onclick: () => setStatus(t, "todo") }, "Back to to do"),
      t.session && h("button", { onclick: () => api("update", { project: t.project, id: t.id, release: true }) }, "Release claim"),
      t.status !== "dropped" && h("button", { class: "danger", onclick: () => setStatus(t, "dropped") }, "Drop"),
    ),
    h(
      "dl",
      { class: "fields" },
      h("dt", {}, "Status"), h("dd", {}, dropdown("status", data.statuses, NAMES, t.status)),
      h("dt", {}, "Priority"), h("dd", {}, dropdown("priority", data.priorities, {}, t.priority)),
      h("dt", {}, "Type"), h("dd", {}, dropdown("type", data.types, TYPE_NAMES, t.type)),
      t.labels.length > 0 && [h("dt", {}, "Labels"), h("dd", {}, t.labels.map((l) => h("span", { class: "chip" }, `#${l}`)))],
      t.session && [h("dt", {}, "Claimed by"), h("dd", {}, url ? h("a", { href: url }, shortSession(t.session)) : t.session)],
      [h("dt", {}, "Created by"), h("dd", {}, shortSession(t.created_by))],
      t.depends_on.length > 0 && [
        h("dt", {}, "Depends on"),
        h("dd", {}, t.depends_on.map((d) => h("a", { href: "#", onclick: (e) => (e.preventDefault(), select(`${t.project}#${d}`)) }, d))),
      ],
      t.files.length > 0 && [
        h("dt", {}, "Files"),
        h("dd", {}, t.files.map((f) => h("a", { href: vscodeURL(f.startsWith("/") ? f : `${t.project}/${f}`) }, f))),
      ],
      [h("dt", {}, "Project"), h("dd", {}, h("a", { href: vscodeURL(t.project) }, t.project))],
      [h("dt", {}, "Updated"), h("dd", { title: t.updated }, `${ago(t.updated)} · created ${t.created.slice(0, 10)}`)],
    ),
    body,
    h(
      "form",
      {
        class: "lognote",
        onsubmit: async (e) => {
          e.preventDefault();
          if (!note.value.trim()) return;
          await api("log", { project: t.project, id: t.id, note: note.value });
          note.value = "";
        },
      },
      note,
      h("button", {}, "Log"),
    ),
  );
  pane.scrollTop = scroll;
}

function agoZh(ts) {
  const d = (Date.now() - Date.parse(ts)) / 1000;
  if (!isFinite(d)) return "";
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const KIND = {
  review: ["待验收", "review"],
  decision: ["待决策", "decide"],
  action: ["需你执行", "decide"],
  push: ["优先推进", "doing"],
};

async function renderReport() {
  const pane = $("#detail");
  const [{ dates }, r] = await Promise.all([
    fetch("/api/reports").then((x) => x.json()),
    fetch(`/api/report${reportDate ? `?date=${reportDate}` : ""}`).then((x) => (x.ok ? x.json() : null)),
  ]);
  if (reportDate == null) return; // closed while loading
  pane.hidden = false;
  pane.classList.add("report");
  const head = h(
    "div",
    { class: "head" },
    h("strong", {}, "今日计划"),
    dates.length > 1 &&
      h(
        "select",
        { onchange: (e) => ((reportDate = e.target.value), renderReport(), syncURL()) },
        dates.map((d) => h("option", { value: d, selected: d === r?.date }, d)),
      ),
    h("button", { class: "ghost x", onclick: () => closeReport(), title: "关闭 (Esc)" }, "✕"),
  );
  if (!r) {
    pane.replaceChildren(head, h("p", { class: "muted" }, "还没有今日计划。每天早上 8 点自动生成，也可以运行 ticketdeck report --save。"));
    return;
  }
  const d = new Date(`${r.date}T00:00`);
  const T = r.totals;
  const status = [T.done && `昨日完成 ${T.done} 项`, T.review && `${T.review} 项待验收`, T.stale && `${T.stale} 项停滞`]
    .filter(Boolean)
    .join(" · ") || `${T.open} 项任务进行中`;
  const open = (i) => select(`${i.root}#${i.id}`);
  const all = allTickets();
  const live = (i) => all.find((t) => t.project === i.root && t.id === i.id);

  const focusRow = (f, n) => {
    const [label, s] = KIND[f.kind] ?? KIND.push;
    const t = live(f);
    const finished = t && (t.status === "done" || t.status === "dropped");
    const url = sessionURL(t?.session ?? f.session);
    return h(
      "li",
      { class: `focus${finished ? " finished" : ""}`, dataset: { s } },
      h("span", { class: "num" }, n),
      h(
        "div",
        { class: "fbody", onclick: () => open(f) },
        h("div", { class: "ft" }, h("span", { class: "fp" }, f.project), " · ", f.title),
        h(
          "div",
          { class: "fm" },
          h("span", { class: "tag" }, finished ? "已完成" : label),
          f.idleDays >= 2 && !finished && h("span", {}, `${f.idleDays} 天未推进`),
          f.reason && h("span", { class: "why" }, f.reason),
        ),
      ),
      !finished &&
        (f.kind === "review"
          ? h("button", { onclick: () => setStatus({ project: f.root, id: f.id }, "done") }, "验收通过")
          : url
            ? h("button", { onclick: () => (location.href = url) }, "继续会话")
            : h("button", { onclick: () => open(f) }, "查看")),
    );
  };
  const fold = (title, count, s, body) =>
    count > 0 && h("details", { class: "fold", dataset: { s } }, h("summary", {}, h("span", { class: "dot" }), title, h("span", { class: "cnt" }, count)), body);
  const list = (items, more) =>
    h(
      "ul",
      { class: "flist" },
      items.map((i) =>
        h("li", { onclick: () => open(i) }, h("span", { class: "fp" }, i.project), h("span", { class: "rt" }, i.title), i.stale && h("span", { class: "warn small" }, "停滞")),
      ),
      more && h("li", { class: "more" }, more),
    );

  pane.replaceChildren(
    ...[
      head,
      h("h1", { class: "rtitle" }, `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK[d.getDay()]}`),
      h("div", { class: "muted small" }, status),
      r.summary && h("p", { class: "summary" }, r.summary),
      h("div", { class: "seclabel" }, "今日重点"),
      r.focus?.length
        ? h("ol", { class: "focuslist" }, r.focus.map((f, i) => focusRow(f, i + 1)))
        : h("p", { class: "muted" }, "今天没有需要你优先处理的任务。"),
      h(
        "div",
        { class: "folds" },
        fold(
          "昨日进展",
          r.activity.length,
          "done",
          h(
            "div",
            { class: "acts" },
            r.activity.map((a) =>
              h(
                "div",
                { class: "act", onclick: () => ((view.project = a.root), closeReport(), render()) },
                h("span", { class: "an" }, a.project),
                a.done > 0 && h("span", { class: "pill", dataset: { s: "done" } }, `完成 ${a.done}`),
                a.updated > 0 && h("span", { class: "pill", dataset: { s: "doing" } }, `更新 ${a.updated}`),
                a.created > 0 && h("span", { class: "pill", dataset: { s: "todo" } }, `新增 ${a.created}`),
              ),
            ),
          ),
        ),
        fold("进行中", r.doing.length, "doing", list(r.doing)),
        fold("待验收", r.review.length, "review", list(r.review)),
        fold("待决策与待执行", T.decisions, "decide", list(r.decisions, T.decisions > r.decisions.length && `另有 ${T.decisions - r.decisions.length} 项，可在看板按标签 decision / needs-user 筛选`)),
        fold(
          "待纳入计划",
          r.leftovers?.length ?? 0,
          "leftover",
          h("ul", { class: "flist" }, (r.leftovers ?? []).map((l) => h("li", {}, h("span", { class: "fp" }, l.project), h("span", { class: "rt" }, l.task)))),
        ),
      ),
    ].filter(Boolean),
  );
}

// MARK: 提议执行

function openProposals() {
  selected = null;
  reportDate = null;
  proposalsOpen = true;
  renderBoard();
  renderDetail();
  syncURL();
}

function closeProposals() {
  proposalsOpen = false;
  renderDetail();
  syncURL();
}

/** What a new Claude Code session gets for a proposal (the same text TabStack sends). */
function proposalPrompt(date, p) {
  const tickets = (p.tickets ?? []).join("、");
  return (
    `（来自 TicketDeck 今日计划 ${date} 的提议 ${p.id}：${p.title}${tickets ? `，涉及 ${tickets}` : ""}）\n\n` +
    `开始前先整理侧边栏：调用 \`mcp__ccd_sidebar__list_groups\`，如果有名字和项目「${p.project}」相同（不区分大小写）的分组，` +
    `就用 \`mcp__ccd_sidebar__move_sessions\`（session_ids: ["self"]）把这个会话移进去；没有就跳过，不要新建分组。\n\n` +
    p.prompt
  );
}

async function setProposal(date, p, status) {
  await api("proposal", { date, id: p.id, status });
}

async function renderProposals() {
  const pane = $("#detail");
  const r = await fetch("/api/report").then((x) => (x.ok ? x.json() : null));
  if (!proposalsOpen) return; // closed while loading
  pane.hidden = false;
  pane.classList.add("report");
  const job = r?.proposeJob;
  const running = job?.state === "running";
  const today = r && r.date === localDay();
  const all = r?.proposals ?? [];
  const open = all.filter((p) => !p.status);
  const started = all.filter((p) => p.status === "started");
  const dismissed = all.filter((p) => p.status === "dismissed");
  const generate = h(
    "button",
    {
      class: "primary",
      disabled: running || !r,
      title: "在后台用 Claude Code 检查所有项目的工单和仓库（只读），把值得清理的任务写进计划，约一两分钟",
      onclick: async () => {
        const res = await fetch("/api/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: r.date }) });
        if (!res.ok) toast((await res.json()).error ?? "启动失败");
        renderProposals();
      },
    },
    running ? "生成中…" : all.length || r?.proposals ? "重新生成" : "生成提议",
  );
  const head = h(
    "div",
    { class: "head" },
    h("strong", {}, "提议执行"),
    r && h("span", { class: "muted small" }, r.date),
    h("button", { class: "ghost x", onclick: () => closeProposals(), title: "关闭 (Esc)" }, "✕"),
  );
  if (!r) {
    pane.replaceChildren(head, h("p", { class: "muted" }, "还没有今日计划。每天早上 8 点自动生成，也可以运行 ticketdeck report --save。"));
    return;
  }
  const row = (p) => {
    const url = `claude://code/new?${new URLSearchParams({ q: proposalPrompt(r.date, p), folder: p.root, source: "url_external" })}`;
    return h(
      "li",
      { class: `proposal${p.status ? ` ${p.status}` : ""}` },
      h(
        "div",
        { class: "fbody" },
        h("div", { class: "ft" }, h("span", { class: "fp" }, p.project), " · ", p.title),
        h(
          "div",
          { class: "fm" },
          p.status === "started" && h("span", { class: "tag", dataset: { s: "done" } }, "已开会话"),
          p.why && h("span", { class: "why" }, p.why),
          (p.tickets ?? []).map((id) =>
            h("a", { href: "#", class: "mono", onclick: (e) => (e.preventDefault(), select(`${p.root}#${id}`)) }, id),
          ),
        ),
        h("details", { class: "pprompt" }, h("summary", {}, "任务说明"), h("pre", {}, p.prompt)),
      ),
      h(
        "div",
        { class: "pbtns" },
        p.status === "dismissed"
          ? h("button", { onclick: () => setProposal(r.date, p, "open") }, "恢复")
          : [
              h(
                "button",
                {
                  class: p.status ? "" : "primary",
                  title: "在项目里新开一个 Claude Code 会话，填好任务说明，按回车开始",
                  onclick: async () => {
                    await setProposal(r.date, p, "started");
                    location.href = url;
                  },
                },
                p.status === "started" ? "再开一次" : "执行",
              ),
              h(
                "button",
                {
                  title: "复制给新会话的任务说明",
                  onclick: async () => {
                    await navigator.clipboard.writeText(proposalPrompt(r.date, p));
                    toast("已复制任务说明");
                  },
                },
                "复制",
              ),
              !p.status && h("button", { class: "ghost", onclick: () => setProposal(r.date, p, "dismissed") }, "忽略"),
            ],
      ),
    );
  };
  pane.replaceChildren(
    ...[
      head,
      h("h1", { class: "rtitle" }, "提议执行"),
      h("div", { class: "muted small" }, "清理类任务：同意后在项目里新开 Claude Code 会话处理，按回车开始。每天早上 8 点随今日计划生成。"),
      today && h("div", { class: "genrow" }, generate, running && h("span", { class: "muted small" }, "在后台运行，写完会自动出现")),
      job?.state === "failed" && today && h("p", { class: "warn small" }, job.error),
      all.length === 0
        ? h("p", { class: "muted" }, r.proposals ? "没有需要清理的任务。" : "还没有提议。")
        : open.length === 0 && started.length === 0 && h("p", { class: "muted" }, "提议都已处理。"),
      open.length > 0 && h("ul", { class: "focuslist" }, open.map(row)),
      started.length > 0 && [h("div", { class: "seclabel" }, `已开会话 · ${started.length}`), h("ul", { class: "focuslist" }, started.map(row))],
      dismissed.length > 0 &&
        h("details", { class: "fold" }, h("summary", {}, h("span", { class: "dot" }), "已忽略", h("span", { class: "cnt" }, dismissed.length)), h("ul", { class: "focuslist" }, dismissed.map(row))),
    ].filter(Boolean).flat(),
  );
  const c = $("#proposals-count");
  c.hidden = !(today && open.length);
  c.textContent = open.length;
}

function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openReport() {
  selected = null;
  proposalsOpen = false;
  reportDate = "";
  renderBoard();
  renderDetail();
  syncURL();
}

function closeReport() {
  reportDate = null;
  renderDetail();
  syncURL();
}

function select(k) {
  if (k) (reportDate = null), (proposalsOpen = false);
  selected = k;
  renderBoard();
  renderDetail();
  syncURL();
}

async function setStatus(t, status) {
  await api("update", { project: t.project, id: t.id, status });
  toast(`${t.id} → ${NAMES[status]}`);
}

function syncURL() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ project: view.project, type: view.type, label: view.label, q: view.q }))
    if (v) p.set(k, v);
  if (view.closed) p.set("closed", "1");
  if (selected) p.set("ticket", selected);
  if (reportDate != null) p.set("report", reportDate);
  if (proposalsOpen) p.set("proposals", "1");
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// MARK: Notifications

function noticeReviews() {
  const now = new Map(allTickets().map((t) => [key(t), t]));
  if (lastStatus) {
    for (const [k, t] of now) {
      const was = lastStatus.get(k);
      if (t.status === "review" && was && was !== "review") {
        const msg = `${t.projectName} ${t.id} is ready for review: ${t.title}`;
        toast(msg, false, () => select(k));
        if ("Notification" in window && Notification.permission === "granted") {
          const n = new Notification("TicketDeck", { body: msg, tag: k });
          n.onclick = () => (window.focus(), select(k));
        }
      }
    }
  }
  lastStatus = new Map([...now].map(([k, t]) => [k, t.status]));
}

function toast(text, error = false, onclick) {
  const el = h("div", { class: `toast${error ? " err" : ""}`, onclick: () => (onclick?.(), el.remove()) }, text);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

// MARK: New ticket

function openNew() {
  const f = $("#new-form");
  f.reset();
  $("#dupes").hidden = true;
  f.project.replaceChildren(...data.projects.map((p) => h("option", { value: p.path, selected: p.path === view.project }, p.name)));
  f.type.replaceChildren(...data.types.map((t) => h("option", { value: t, selected: t === "feature" }, TYPE_NAMES[t] ?? t)));
  f.priority.replaceChildren(...data.priorities.map((p) => h("option", { value: p, selected: p === "P2" }, p)));
  if (!data.projects.length) return toast("No projects yet: run `ticketdeck init` in one first", true);
  $("#new-dialog").showModal();
  f.title.focus();
}

async function submitNew(force) {
  const f = $("#new-form");
  if (!f.reportValidity()) return;
  const out = await api("create", {
    project: f.project.value,
    title: f.title.value,
    body: f.body.value,
    type: f.type.value,
    priority: f.priority.value,
    labels: f.labels.value.split(",").map((s) => s.trim()).filter(Boolean),
    force,
  });
  if (out.duplicates) {
    const box = $("#dupes");
    box.hidden = false;
    box.replaceChildren(
      "Similar open tickets already exist:",
      h("ul", {}, out.duplicates.map((d) => h("li", {}, `${d.id} ${d.title}`))),
      h("button", { type: "button", onclick: () => submitNew(true) }, "Create anyway"),
    );
    return;
  }
  $("#new-dialog").close();
  toast(`Created ${out.ticket.id}`);
  selected = `${f.project.value}#${out.ticket.id}`;
}

// MARK: Wiring

$("#f-project").onchange = (e) => ((view.project = e.target.value), render());
$("#f-type").onchange = (e) => ((view.type = e.target.value), render());
$("#f-label").onchange = (e) => ((view.label = e.target.value), render());
$("#f-search").oninput = (e) => ((view.q = e.target.value), renderBoard(), syncURL());
$("#f-closed").onchange = (e) => ((view.closed = e.target.checked), load());
$("#new").onclick = openNew;
$("#report").onclick = () => (reportDate != null ? closeReport() : openReport());
$("#proposals").onclick = () => (proposalsOpen ? closeProposals() : openProposals());
$("#new-form").addEventListener("submit", (e) => {
  if (e.submitter?.value !== "create") return;
  e.preventDefault();
  submitNew(false);
});

if ("Notification" in window && Notification.permission === "default") {
  const b = $("#notify");
  b.hidden = false;
  b.onclick = () => Notification.requestPermission().then(() => (b.hidden = true));
}

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape" && !$("#new-dialog").open)
    proposalsOpen && !selected ? closeProposals() : reportDate != null && !selected ? closeReport() : select(null);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "n") (e.preventDefault(), openNew());
  if (e.key === "/") (e.preventDefault(), $("#f-search").focus());
  if (e.key === "r") (e.preventDefault(), reportDate != null ? closeReport() : openReport());
  if (e.key === "p") (e.preventDefault(), proposalsOpen ? closeProposals() : openProposals());
});

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => $("#live").classList.add("on"));
  es.addEventListener("change", () => load());
  es.onerror = () => $("#live").classList.remove("on");
}

await load();
connect();
