/**
 * [INPUT]: node-diff3 的 diffComm
 * [OUTPUT]: summarize 把一次改动压成一句话，例如「+ 周三练腿」「冲突分两层 → 冲突分三层」「改了 3 处」
 * [POS]: core 的文案层，同步记录每一行中间那句话从这里来；界面不出现 Git 术语
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { diffComm } from "node-diff3";
import { splitLines } from "./merge";

const MAX = 36;
/* 去掉列表和标题记号，只留字 */
const clean = (s: string) => {
  const t = s.replace(/^\s*(?:[-*+]\s+\[.\]\s+|[-*+]\s+|\d+\.\s+|#{1,6}\s+|>\s*)/, "").trim();
  return t.length > MAX ? t.slice(0, MAX) + "…" : t;
};

/** old 为 null 是新建，next 为 null 是删除；附件传 binary */
export function summarize(old: string | null, next: string | null, binary = false): string {
  if (old === null) return "新建";
  if (next === null) return "删除";
  if (binary) return "换了内容";
  const hunks = diffComm(splitLines(old), splitLines(next))
    .filter((c) => !c.common)
    .map((c) => ({
      del: (c.buffer1 ?? []).filter((l) => l.trim() !== ""),
      add: (c.buffer2 ?? []).filter((l) => l.trim() !== ""),
    }))
    .filter((h) => h.del.length || h.add.length);
  if (!hunks.length) return "改了空行";
  if (hunks.length === 1) {
    const { del, add } = hunks[0];
    if (!del.length && add.length === 1) return `+ ${clean(add[0])}`;
    if (del.length === 1 && !add.length) return `- ${clean(del[0])}`;
    if (del.length === 1 && add.length === 1) return `${clean(del[0])} → ${clean(add[0])}`;
    if (!del.length) return `+ ${add.length} 行`;
    if (!add.length) return `- ${del.length} 行`;
  }
  return `改了 ${hunks.length} 处`;
}
