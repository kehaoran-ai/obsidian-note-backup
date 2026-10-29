/**
 * [INPUT]: 无(纯 DOM)
 * [OUTPUT]: 四屏共用的小零件：时间说法、篇名、状态点、标签、按钮、提示条
 * [POS]: ui 的公共件。所有用户可见的字都用 textContent 写入，不拼 HTML
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Notice } from "obsidian";
import { svgIcon, type IconName } from "./icons";

/** 篇名：去掉文件夹和 .md */
export const noteName = (path: string) => path.split("/").pop()?.replace(/\.md$/, "") ?? path;

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「今天 · 10 月 29 日」「昨天 · 10 月 28 日」「10 月 27 日 · 周一」；short 用在版本列表 */
export function dayLabel(t: number, now = Date.now()): { long: string; short: string } {
  const d = new Date(t);
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const diff = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (diff === 0) return { long: `今天 · ${md}`, short: "今天" };
  if (diff === 1) return { long: `昨天 · ${md}`, short: "昨天" };
  const y = d.getFullYear() === new Date(now).getFullYear() ? "" : `${d.getFullYear()} 年 `;
  return { long: `${y}${md} · ${WEEK[d.getDay()]}`, short: `${y}${md}` };
}

export function ago(t: number, now = Date.now()): string {
  if (!t) return "还没备份过";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export type DotKind = "ok" | "warn" | "off" | "run" | "none";
export const dot = (parent: HTMLElement, kind: DotKind) => parent.createSpan({ cls: `nb-dot is-${kind}` });

export function chip(parent: HTMLElement, text: string, icon?: IconName): HTMLElement {
  const c = parent.createSpan({ cls: "nb-chip" });
  if (icon) svgIcon(c, icon);
  c.createSpan({ text });
  return c;
}

export function button(parent: HTMLElement, text: string, kind: "primary" | "ghost" | "tag" | "tag-sm", onClick: () => void, icon?: IconName): HTMLButtonElement {
  /* 主按钮用 Obsidian 自带的 mod-cta：用户主题怎么画主按钮，这里就怎么画 */
  const b = parent.createEl("button", { cls: `nb-btn is-${kind}${kind === "primary" ? " mod-cta" : ""}` });
  if (icon) svgIcon(b, icon);
  b.createSpan({ text });
  b.addEventListener("click", onClick);
  return b;
}

/** 底部提示条，可带一个动作(撤销、去看) */
export function toast(text: string, action?: { label: string; run: () => void }, ms = 5000) {
  const frag = document.createDocumentFragment();
  const wrap = frag.createSpan({ cls: "nb-toast" });
  wrap.createSpan({ text });
  if (action) {
    const a = wrap.createEl("a", { text: action.label, cls: "nb-toast-act" });
    a.addEventListener("click", () => action.run());
  }
  new Notice(frag, ms);
}

/** 进度条 */
export function meter(parent: HTMLElement, label: string, done: number, total: number, ok = false) {
  const row = parent.createDiv({ cls: "nb-meter-l" });
  row.createSpan({ text: label });
  const n = row.createSpan();
  n.createEl("b", { text: String(done) });
  n.appendText(` / ${total} 篇`);
  const bar = parent.createDiv({ cls: "nb-meter" }).createEl("i");
  bar.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  if (ok) bar.addClass("is-ok");
}
