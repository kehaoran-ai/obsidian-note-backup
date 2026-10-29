/**
 * [INPUT]: node-diff3 的 diffIndices / diffComm(行级最长公共子序列)
 * [OUTPUT]: regions3 三方分区、merge3 自动合并、pseudoBase 无旧版时的旧版、mergeBlocks 合并页的分块、wordMarks 字词高亮、assemble 按选择拼出结果
 * [POS]: core 的合并算法，冲突三层规则的第 1、2 层在 merge3，第 3 层(事后合并页)在 mergeBlocks
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { diffComm, diffIndices } from "node-diff3";

export const splitLines = (s: string): string[] => s.split("\n");
export const joinLines = (a: string[]): string => a.join("\n");
const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/** 三方的一段：o 旧版，a 一边，b 另一边 */
export interface Region {
  o: string[];
  a: string[];
  b: string[];
}

interface Hunk {
  side: "a" | "b";
  oStart: number;
  oLen: number;
  start: number;
  len: number;
}

/**
 * 把 a、b 相对旧版 o 的改动切成段。不同段落各自独立；
 * 两边改动挨着或重叠的，并成一段(这一段才可能合不了)。
 */
export function regions3(a: string[], o: string[], b: string[]): Region[] {
  const hunks: Hunk[] = [];
  for (const h of diffIndices(o, a)) hunks.push({ side: "a", oStart: h.buffer1[0], oLen: h.buffer1[1], start: h.buffer2[0], len: h.buffer2[1] });
  for (const h of diffIndices(o, b)) hunks.push({ side: "b", oStart: h.buffer1[0], oLen: h.buffer1[1], start: h.buffer2[0], len: h.buffer2[1] });
  hunks.sort((x, y) => x.oStart - y.oStart || (x.side === "a" ? -1 : 1));

  const out: Region[] = [];
  let at = 0;
  const stable = (end: number) => {
    if (end > at) {
      const s = o.slice(at, end);
      out.push({ o: s, a: s, b: s });
    }
  };
  while (hunks.length) {
    const first = hunks.shift() as Hunk;
    const group = [first];
    const start = first.oStart;
    let end = first.oStart + first.oLen;
    while (hunks.length && hunks[0].oStart <= end) {
      const h = hunks.shift() as Hunk;
      group.push(h);
      end = Math.max(end, h.oStart + h.oLen);
    }
    stable(start);
    /* 每一边在这段里的范围：由它自己的改动推出来；这段里没改的一边就是旧版原样 */
    const span = (side: "a" | "b", buf: string[]): string[] => {
      const hs = group.filter((h) => h.side === side);
      if (!hs.length) return o.slice(start, end);
      const oLo = Math.min(...hs.map((h) => h.oStart));
      const oHi = Math.max(...hs.map((h) => h.oStart + h.oLen));
      const lo = Math.min(...hs.map((h) => h.start)) + (start - oLo);
      const hi = Math.max(...hs.map((h) => h.start + h.len)) + (end - oHi);
      return buf.slice(lo, hi);
    };
    out.push({ o: o.slice(start, end), a: span("a", a), b: span("b", b) });
    at = end;
  }
  stable(o.length);
  return out;
}

/** 两边都改了、改得不一样的段 */
export const isClash = (r: Region) => !same(r.a, r.o) && !same(r.b, r.o) && !same(r.a, r.b);

/**
 * 冲突第 1、2 层：不同段落两边都保留；同一段两边改得不一样，用 prefer 那边。
 * conflicts 是用了 prefer 的处数，大于 0 就要亮黄点。
 */
export function merge3(mine: string, base: string, theirs: string, prefer: "mine" | "theirs"): { text: string; conflicts: number } {
  const out: string[] = [];
  let conflicts = 0;
  for (const r of regions3(splitLines(mine), splitLines(base), splitLines(theirs))) {
    if (isClash(r)) {
      conflicts++;
      out.push(...(prefer === "mine" ? r.a : r.b));
    } else out.push(...(same(r.a, r.o) ? r.b : r.a));
  }
  return { text: joinLines(out), conflicts };
}

/** 第二台设备第一次合并没有共同旧版：把两边相同的行当旧版，各自多出来的行就能自动合 */
export function pseudoBase(a: string, b: string): string {
  return joinLines(diffComm(splitLines(a), splitLines(b)).flatMap((c) => c.common ?? []));
}

/** 合并页的一块 */
export type Block =
  | { kind: "same"; lines: string[] }
  /** 被盖掉的那边改的，已经自动合进现在这版 */
  | { kind: "auto"; lines: string[] }
  | { kind: "clash"; now: string[]; old: string[] };

/** 第 3 层：现在的(含之后又改的) vs 被盖掉的，以共同旧版为准切块 */
export function mergeBlocks(current: string, base: string, loser: string): Block[] {
  const blocks: Block[] = [];
  for (const r of regions3(splitLines(current), splitLines(base), splitLines(loser))) {
    const aChanged = !same(r.a, r.o);
    const bChanged = !same(r.b, r.o);
    if (!bChanged) blocks.push({ kind: "same", lines: r.a });
    else if (aChanged && same(r.a, r.b)) blocks.push({ kind: "auto", lines: r.a });
    else blocks.push({ kind: "clash", now: r.a, old: r.b });
  }
  return blocks.filter((b) => b.kind === "clash" || b.lines.length > 0);
}

export type Pick = "now" | "old" | "both";

/** 按每处的选择拼出结果；没选的处按「现在的」 */
export function assemble(blocks: Block[], picks: Record<number, Pick>): string {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== "clash") return out.push(...b.lines);
    const p = picks[i] ?? "now";
    if (p !== "old") out.push(...b.now);
    if (p !== "now") out.push(...b.old);
  });
  return joinLines(out);
}

/** 一行里的一截：mark 为真是两边不一样的字 */
export type Seg = { s: string; mark: boolean };

const TOKEN = /\s+|[A-Za-z0-9_]+|[\s\S]/gu;
const tokens = (s: string) => s.match(TOKEN) ?? [];

/** 字词级高亮：两边对比，各自返回按行切好的段 */
export function wordMarks(now: string[], old: string[]): { now: Seg[][]; old: Seg[][] } {
  const left: Seg[] = [];
  const right: Seg[] = [];
  for (const c of diffComm(tokens(joinLines(now)), tokens(joinLines(old)))) {
    if (c.common) {
      const s = c.common.join("");
      left.push({ s, mark: false });
      right.push({ s, mark: false });
    } else {
      if (c.buffer1.length) left.push({ s: c.buffer1.join(""), mark: true });
      if (c.buffer2.length) right.push({ s: c.buffer2.join(""), mark: true });
    }
  }
  return { now: byLine(left), old: byLine(right) };
}

function byLine(segs: Seg[]): Seg[][] {
  const out: Seg[][] = [[]];
  for (const seg of segs) {
    seg.s.split("\n").forEach((piece, i) => {
      if (i > 0) out.push([]);
      if (piece) out[out.length - 1].push({ s: piece, mark: seg.mark && piece.trim() !== "" });
    });
  }
  return out;
}

/** 和现在不一样的行(历史版本预览里标灰底) */
export function changedLines(version: string[], current: string[]): boolean[] {
  const flags = version.map(() => true);
  let i = 0;
  for (const c of diffComm(version, current)) {
    if (c.common) {
      for (let k = 0; k < c.common.length; k++) flags[i + k] = false;
      i += c.common.length;
    } else i += c.buffer1.length;
  }
  return flags;
}
