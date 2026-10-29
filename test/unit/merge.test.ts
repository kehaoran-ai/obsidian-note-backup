/**
 * [INPUT]: core 的 merge / summary / bytes
 * [OUTPUT]: 合并算法、合并页分块、改动文案、内容指纹的测试
 * [POS]: 单测，对应任务卡的交付目标 3(合并页每处能选留哪边)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { describe, expect, it } from "vitest";
import { asText, fromBase64, gitBlobSha, toBase64, utf8 } from "../../src/core/bytes";
import { assemble, changedLines, merge3, mergeBlocks, pseudoBase, wordMarks } from "../../src/core/merge";
import { summarize } from "../../src/core/summary";

const BASE = ["# 周计划", "## 本周三件事", "- P-193 周五开写", "- Wapopo 画风", "- 录视频：插件怎么用", "## 每天", "- 练腿", "## 读书", "- 读完第 3 章"].join("\n");

describe("merge3", () => {
  it("同一处改得不一样：按 prefer 选，计一处", () => {
    const mine = BASE.replace("周五", "周四");
    const theirs = BASE.replace("周五", "周三").replace("练腿", "周三练腿，周五练背");
    const m = merge3(mine, BASE, theirs, "theirs");
    expect(m.conflicts).toBe(1);
    expect(m.text).toBe(theirs);
    const m2 = merge3(mine, BASE, theirs, "mine");
    expect(m2.text).toBe(BASE.replace("周五", "周四").replace("练腿", "周三练腿，周五练背"));
  });

  it("两边改成一样的不算冲突", () => {
    const x = BASE.replace("练腿", "练背");
    expect(merge3(x, BASE, x, "mine")).toEqual({ text: x, conflicts: 0 });
  });

  it("两边都在结尾加行：挨着的改动算一处", () => {
    const m = merge3(BASE + "\n- a", BASE, BASE + "\n- b", "mine");
    expect(m.conflicts).toBe(1);
    expect(m.text).toBe(BASE + "\n- a");
  });
});

describe("pseudoBase", () => {
  it("没有共同旧版：两边相同的行当旧版，各自多出的段落都能留下", () => {
    const a = "# x\n电脑\n\n共同";
    const b = "# x\n\n共同\n\n手机";
    const m = merge3(a, pseudoBase(a, b), b, "mine");
    expect(m.text).toContain("电脑");
    expect(m.text).toContain("手机");
    expect(m.conflicts).toBe(0);
  });
});

describe("合并页", () => {
  /* 手机 14:02 较新被采用，电脑 13:48 被盖掉；电脑另外改的「读书」那行已自动合进来 */
  const phone = BASE.replace("周五开写", "周四开写").replace("插件怎么用", "为什么做这个插件");
  const mac = BASE.replace("插件怎么用", "插件怎么用(电脑)").replace("读完第 3 章", "读完第 3 章，写读书笔记");
  const current = merge3(phone, BASE, mac, "mine").text;

  it("分出：两边一样、自动合进来、合不了三种块", () => {
    const blocks = mergeBlocks(current, BASE, mac);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds.filter((k) => k === "clash")).toHaveLength(1);
    expect(kinds).toContain("auto");
    const clash = blocks.find((b) => b.kind === "clash");
    expect(clash).toMatchObject({ now: ["- 录视频：为什么做这个插件"], old: ["- 录视频：插件怎么用(电脑)"] });
  });

  it("每处能选留左边、留右边、都要", () => {
    const blocks = mergeBlocks(current, BASE, mac);
    const i = blocks.findIndex((b) => b.kind === "clash");
    expect(assemble(blocks, {})).toBe(current);
    expect(assemble(blocks, { [i]: "old" })).toContain("插件怎么用(电脑)");
    expect(assemble(blocks, { [i]: "old" })).not.toContain("为什么做这个插件");
    const both = assemble(blocks, { [i]: "both" });
    expect(both).toContain("为什么做这个插件\n- 录视频：插件怎么用(电脑)");
  });

  it("合完之后用户又在编辑器里改了：改动保留，不当成冲突", () => {
    const edited = current.replace("Wapopo 画风", "Wapopo 画风再调一轮");
    const blocks = mergeBlocks(edited, BASE, mac);
    expect(assemble(blocks, {})).toBe(edited);
  });

  it("字词高亮只标不一样的字", () => {
    const w = wordMarks(["- P-193 周五开写"], ["- P-193 周四开写"]);
    expect(w.now[0].filter((s) => s.mark).map((s) => s.s)).toEqual(["五"]);
    expect(w.old[0].filter((s) => s.mark).map((s) => s.s)).toEqual(["四"]);
  });

  it("历史版本里和现在不一样的行", () => {
    expect(changedLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([false, true, false]);
  });
});

describe("summarize", () => {
  it("一句话说清改了什么", () => {
    expect(summarize(null, "x")).toBe("新建");
    expect(summarize("x", null)).toBe("删除");
    expect(summarize("# a\n- 练腿", "# a\n- 练腿\n- 周三练腿，周五练背")).toBe("+ 周三练腿，周五练背");
    expect(summarize("- 冲突分两层", "- 冲突分三层")).toBe("冲突分两层 → 冲突分三层");
    expect(summarize("a\nb\nc\nd", "A\nb\nC\nd")).toBe("改了 2 处");
  });
});

describe("bytes", () => {
  it("内容指纹和 git hash-object 一致", async () => {
    expect(await gitBlobSha(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
  it("文本判定：带 NUL 或不是 UTF-8 的算附件；BOM 保留", () => {
    expect(asText(new Uint8Array([0x89, 0x50, 0x00]))).toBeNull();
    expect(asText(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(asText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
  });
  it("base64 往返", () => {
    const d = new Uint8Array(70000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(d))).toEqual(d);
  });
});
