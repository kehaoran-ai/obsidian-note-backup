/**
 * [INPUT]: core 的 Engine(分段提交、暂停)，fakes 的内存笔记库与云端
 * [OUTPUT]: 大批备份分段生效、暂停后接着传、中途断网不白传、冲突被打断不丢内容的测试
 * [POS]: 单测，对应老板 2026-10-29 提的「没有终止备份的按钮」和第一次备份中途失败
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine";
import { SyncLog } from "../../src/core/log";
import { emptyState, type SyncState } from "../../src/core/types";
import { MemLocal, MemRemote } from "./fakes";

let clock: { t: number };
let remote: MemRemote;
beforeEach(async () => {
  clock = { t: 1000 };
  remote = new MemRemote(clock);
  await remote.init();
});

function device(dev: string, opts: { chunk?: number; checkpoint?: (st: SyncState) => Promise<void> } = {}) {
  const local = new MemLocal(clock);
  const state = emptyState();
  const log = new SyncLog();
  const engine = new Engine(
    { local, remote, log, device: () => dev, defaultWho: "me", now: () => ++clock.t, chunk: opts.chunk, checkpoint: () => opts.checkpoint?.(state) ?? Promise.resolve() },
    state,
  );
  return { local, state, engine, log };
}

const remoteCount = async () => Object.keys((await remote.tree(remote.headSha as string)).files).filter((p) => !p.startsWith(".")).length;

describe("分段提交", () => {
  it("7 篇按 3 篇一段，传 3 段，每段存一次进度", async () => {
    let saves = 0;
    const a = device("Mac", { chunk: 3, checkpoint: async () => void saves++ });
    for (let i = 0; i < 7; i++) a.local.put(`n${i}.md`, `第 ${i} 篇`);
    const r = await a.engine.sync();
    expect(saves).toBe(3);
    expect(r.commits).toHaveLength(3);
    expect(await remoteCount()).toBe(7);
    expect(await a.engine.pending()).toEqual([]);
  });

  it("传完第一段点了暂停：已传的留着，下次接着传剩下的，不重复", async () => {
    const ac = new AbortController();
    const a = device("Mac", { chunk: 3, checkpoint: async () => ac.abort() });
    for (let i = 0; i < 7; i++) a.local.put(`n${i}.md`, `第 ${i} 篇`);
    const r1 = await a.engine.sync(undefined, ac.signal);
    expect(r1.stopped).toBe(true);
    expect(await remoteCount()).toBe(3);
    expect(await a.engine.pending()).toHaveLength(4);
    const r2 = await a.engine.sync();
    expect(r2.up).toHaveLength(4);
    expect(await remoteCount()).toBe(7);
    expect(await a.engine.pending()).toEqual([]);
  });

  it("第二段断网：第一段已生效不白传，下次从第二段接着", async () => {
    const a = device("Mac", { chunk: 3 });
    for (let i = 0; i < 7; i++) a.local.put(`n${i}.md`, `第 ${i} 篇`);
    remote.failOnWrite = 2;
    await expect(a.engine.sync()).rejects.toThrow("断网了");
    expect(await remoteCount()).toBe(3);
    remote.failOnWrite = undefined;
    const r = await a.engine.sync();
    expect(r.up).toHaveLength(4);
    expect(await remoteCount()).toBe(7);
  });

  it("两边都改了的那篇排在第一段；之后被暂停，下次再合一遍，两边的改动都在", async () => {
    const a = device("Mac", { chunk: 2 });
    const b = device("iPhone", { chunk: 2 });
    a.local.put("周计划.md", "# 周计划\n\n- 周五开写\n\n- 练腿");
    await a.engine.sync();
    await b.engine.sync();
    /* 电脑先改(较旧)，手机后改(较新)：合不了的那处用手机的，电脑另一段的改动自动合进来 */
    a.local.put("周计划.md", "# 周计划\n\n- 周四开写\n\n- 练腿练背");
    for (let i = 0; i < 5; i++) a.local.put(`n${i}.md`, `第 ${i} 篇`);
    b.local.put("周计划.md", "# 周计划\n\n- 周三开写\n\n- 练腿");
    await b.engine.sync();
    const ac = new AbortController();
    const a2 = new Engine({ local: a.local, remote, log: a.log, device: () => "Mac", defaultWho: "me", now: () => ++clock.t, chunk: 2, checkpoint: async () => ac.abort() }, a.state);
    const r1 = await a2.sync(undefined, ac.signal);
    expect(r1.stopped).toBe(true);
    expect(a.state.clashes.map((c) => c.path)).toEqual(["周计划.md"]);
    /* 云端第一段已经是合好的版本；本地还没写回(被暂停) */
    expect(a.local.text("周计划.md")).toBe("# 周计划\n\n- 周四开写\n\n- 练腿练背");
    expect(await remote.textAtHead("周计划.md")).toBe("# 周计划\n\n- 周三开写\n\n- 练腿练背");
    await a.engine.sync();
    expect(a.local.text("周计划.md")).toBe("# 周计划\n\n- 周三开写\n\n- 练腿练背");
    expect(await remote.textAtHead("周计划.md")).toBe("# 周计划\n\n- 周三开写\n\n- 练腿练背");
    expect(await remoteCount()).toBe(6);
    await b.engine.sync();
    expect(b.local.text("周计划.md")).toBe("# 周计划\n\n- 周三开写\n\n- 练腿练背");
  });
});
