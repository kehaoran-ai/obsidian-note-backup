/**
 * [INPUT]: 插件本体的 log(同步记录)与 state.clashes(两边都改了)
 * [OUTPUT]: LogView 同步记录：按天分组，一篇一张卡，一行一次改动，灰线是我、蓝线是 AI，可按全部 / 我 / AI 筛
 * [POS]: 设计稿第 3 屏左半。以篇为核心：先看哪篇，再看改了什么，最后看谁改的；点一行进历史版本
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ItemView, Platform, type WorkspaceLeaf } from "obsidian";
import type { Who } from "../core/types";
import type NoteBackupPlugin from "../main";
import { barText } from "./status";
import { svgIcon } from "./icons";
import { button, dayLabel, dot, hhmm, noteName } from "./kit";

export const LOG_VIEW = "note-backup-log";

interface Row {
  path: string;
  who: Who;
  dev: string;
  t: number;
  s: string;
  k?: "won" | "lost";
  commit: string;
}

type Filter = "all" | Who;
const MAX_DAYS = 60;
/** 一次画几张卡 */
const PAGE = 40;

/** 两条线：左灰线是我，右蓝线是 AI；同一条线从这篇第一次出现连到最后一次 */
function lanes(el: HTMLElement, rows: Row[], k: number) {
  const span: Partial<Record<Who, [number, number]>> = {};
  rows.forEach((r, i) => {
    const s = span[r.who] ?? (span[r.who] = [i, i]);
    s[1] = i;
  });
  const lane = el.createSpan({ cls: "nb-lane" });
  for (const w of ["me", "ai"] as Who[]) {
    const i = lane.createEl("i", { cls: `is-${w}` });
    const s = span[w];
    if (!s) continue;
    if (k > s[0] && k <= s[1]) i.addClass("t");
    if (k >= s[0] && k < s[1]) i.addClass("b");
    if (rows[k].who === w) i.createEl("b");
  }
}

export class LogView extends ItemView {
  private filter: Filter = "all";
  private expanded = new Set<string>();
  private off: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: NoteBackupPlugin) {
    super(leaf);
  }

  getViewType() {
    return LOG_VIEW;
  }
  getDisplayText() {
    return "同步记录";
  }
  getIcon() {
    return "nb-cloud";
  }

  async onOpen() {
    this.contentEl.addClass("nb-log");
    if (Platform.isMobile) this.contentEl.addClass("is-mobile");
    this.render();
    /* 进度每跳一下都会通知；记录本身没变时只改顶上那句状态，不重画整页 */
    this.off = this.plugin.subscribe(() => {
      if (this.sig() !== this.lastSig) this.render();
      else this.contentEl.querySelector(".nb-side-h > small")?.setText(barText(this.plugin.status));
    });
  }

  private lastSig = "";
  private sig() {
    const { log, state, connected } = this.plugin;
    return `${connected}|${log.commits.length}|${log.commits[0]?.sha}|${state.clashes.map((c) => c.path).join("/")}`;
  }

  async onClose() {
    this.off?.();
  }

  private rows(): Row[] {
    const out: Row[] = [];
    for (const c of this.plugin.log.commits) {
      if (this.filter !== "all" && c.who !== this.filter) continue;
      for (const f of c.files) out.push({ path: f.p, who: c.who, dev: c.dev, t: f.t, s: f.s, k: f.k, commit: c.sha });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  /** 按天按篇分好组的结果；记录或筛选变了才重算 */
  private groups: { day: string; path: string; rows: Row[] }[] = [];
  private groupsKey = "";
  private shown = 0;

  /** 三个筛选各算一次就记住，来回切不重算 */
  private cache = new Map<string, { day: string; path: string; rows: Row[] }[]>();

  private buildGroups() {
    const key = `${this.sig()}|${this.filter}`;
    if (key === this.groupsKey) return;
    this.groupsKey = key;
    const hit = this.cache.get(key);
    if (hit) {
      this.groups = hit;
      return;
    }
    if (![...this.cache.keys()].some((k) => k.startsWith(this.sig()))) this.cache.clear();
    const days = new Map<string, Map<string, Row[]>>();
    for (const r of this.rows()) {
      const d = dayLabel(r.t).long;
      if (!days.has(d)) {
        if (days.size >= MAX_DAYS) break;
        days.set(d, new Map());
      }
      const files = days.get(d) as Map<string, Row[]>;
      if (!files.has(r.path)) files.set(r.path, []);
      (files.get(r.path) as Row[]).push(r);
    }
    this.groups = [];
    for (const [day, files] of days) for (const [path, rows] of files) this.groups.push({ day, path, rows });
    this.cache.set(key, this.groups);
  }

  render() {
    this.lastSig = this.sig();
    const el = this.contentEl;
    const keepScroll = el.querySelector(".nb-logs")?.scrollTop ?? 0;
    const keepShown = this.shown;
    el.empty();
    const head = el.createDiv({ cls: "nb-side-h" });
    const row = head.createDiv({ cls: "nb-row" });
    row.createEl("b", { text: "同步记录" });
    const well = row.createDiv({ cls: "nb-well is-sm" });
    for (const [f, label] of [["all", "全部"], ["me", "我"], ["ai", "AI"]] as [Filter, string][]) {
      const b = well.createEl("button", { text: label, cls: this.filter === f ? "is-on" : "" });
      b.addEventListener("click", () => {
        if (this.filter === f) return;
        this.filter = f;
        well.querySelectorAll("button").forEach((x) => x.toggleClass("is-on", x === b));
        this.renderList(logs, 0);
        logs.scrollTop = 0;
      });
    }
    head.createEl("small", { text: barText(this.plugin.status) });
    const logs = el.createDiv({ cls: "nb-logs" });
    logs.addEventListener("scroll", () => this.onScroll?.(), { passive: true });
    this.renderList(logs, keepShown);
    logs.scrollTop = keepScroll;
  }

  /** 只画看得见的：先画 40 张卡，滚到底再接着画，几千篇也不卡 */
  private renderList(logs: HTMLElement, atLeast: number) {
    logs.empty();
    this.shown = 0;
    if (!this.plugin.connected) {
      const e = logs.createDiv({ cls: "nb-empty", text: "还没开启备份。" });
      button(e.createDiv(), "开启备份", "primary", () => this.plugin.openLogin());
      return;
    }
    this.buildGroups();
    if (!this.groups.length) {
      logs.createDiv({ cls: "nb-empty", text: this.filter === "all" ? "还没有同步记录。改完笔记会自动备份。" : "这个范围里没有改动。" });
      return;
    }
    const sentinel = logs.createDiv({ cls: "nb-more" });
    const more = () => {
      const clashes = new Map(this.plugin.state.clashes.map((c) => [c.path, c]));
      const frag = document.createDocumentFragment();
      const host = frag.createDiv();
      const end = Math.min(this.groups.length, this.shown + PAGE);
      for (let i = this.shown; i < end; i++) {
        const g = this.groups[i];
        if (i === 0 || this.groups[i - 1].day !== g.day) host.createDiv({ cls: "nb-day", text: g.day });
        this.card(host, g.day, g.path, g.rows, clashes.get(g.path));
      }
      while (host.firstChild) logs.insertBefore(host.firstChild, sentinel);
      this.shown = end;
      if (this.shown >= this.groups.length) sentinel.remove();
    };
    do more();
    while (this.shown < Math.min(atLeast, this.groups.length));
    /* 滚到离底部 600 像素内就接着画 */
    const near = () => this.shown < this.groups.length && logs.scrollTop + logs.clientHeight > logs.scrollHeight - 600;
    this.onScroll = () => {
      if (near()) more();
    };
  }

  private onScroll: (() => void) | null = null;

  private card(parent: HTMLElement, day: string, path: string, all: Row[], clash?: { winnerLabel: { dev: string } }) {
    const key = day + path;
    const more = this.expanded.has(key) ? 0 : Math.max(0, all.length - 3);
    const rows = more ? all.slice(0, 3) : all;
    const fc = parent.createDiv({ cls: "nb-fc" });
    const h = fc.createDiv({ cls: "nb-fc-h" });
    svgIcon(h, "file");
    const a = h.createEl("a", { text: noteName(path), attr: { title: path } });
    a.addEventListener("click", () => {
      const vs = this.plugin.log.versions(path);
      void this.plugin.openHistory(path, vs.length > 1 ? 1 : 0);
    });
    const small = h.createEl("small");
    if (clash) {
      dot(small, "warn");
      small.appendText("两边都改了");
    } else small.setText(`${all.length} 次`);

    rows.forEach((r, k) => {
      const ch = fc.createDiv({ cls: "nb-ch" });
      if (clash && r.k) ch.addClass("is-clash");
      lanes(ch, rows, k);
      ch.createSpan({ cls: "nb-s", text: r.s });
      ch.createEl("small", { text: `${r.who === "me" ? "我" : "AI"} · ${hhmm(r.t)}` });
      ch.setAttr("title", `${r.dev} · ${new Date(r.t).toLocaleString()}`);
      ch.addEventListener("click", () => {
        const vs = this.plugin.log.versions(path);
        const i = vs.findIndex((v) => v.commit === r.commit && v.t === r.t);
        void this.plugin.openHistory(path, Math.max(0, i));
      });
    });
    if (more) {
      const b = fc.createEl("button", { cls: "nb-fc-more", text: `还有 ${more} 次` });
      b.addEventListener("click", () => {
        this.expanded.add(key);
        const fresh = createDiv();
        this.card(fresh, day, path, all, clash);
        fc.replaceWith(fresh.firstChild as HTMLElement);
      });
    }
    if (clash) {
      const w = fc.createDiv({ cls: "nb-fc-warn" });
      svgIcon(w, "info");
      w.createSpan({ text: `先用了较新的${clash.winnerLabel.dev}版` });
      button(w, "去合并", "tag-sm", () => void this.plugin.openMerge(path));
    }
  }
}
