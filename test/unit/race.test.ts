/**
 * [INPUT]: core 的 Engine，fakes 的内存笔记库(外部写入慢一拍)与云端(分支头读到旧值)
 * [OUTPUT]: 外部进程刚写的篇不被盖回旧版、不被删，两轮同步不叠在一起，跳过的写入有记录
 * [POS]: 单测，对应 P-230:2026-10-29 晚上插件同步完 2–6 秒内把 AI 会话刚写的卡改回旧版、把新建的文件丢进废纸篓
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

let n = 0;
/** 一台设备一条队；shared 给的是同一台设备上插件重载后的新引擎，和旧的排同一条队 */
function device(dev: string, shared?: { local: MemLocal; state: SyncState; log: SyncLog; lock: string }) {
  const local = shared?.local ?? new MemLocal(clock);
  const state = shared?.state ?? emptyState();
  const log = shared?.log ?? new SyncLog();
  const lock = shared?.lock ?? `${dev}-${++n}`;
  const engine = new Engine({ local, remote, log, device: () => dev, defaultWho: "ai", now: () => ++clock.t, lock }, state);
  return { local, state, log, lock, engine };
}

describe("云端分支头读到旧值(GitHub 接口缓存 60 秒)", () => {
  it("刚备份上去的新篇不删，刚改的篇不改回上一版", async () => {
    const a = device("Mac");
    a.local.put("卡.md", "第一版");
    await a.engine.sync();
    const old = remote.headSha as string;
    a.local.put("卡.md", "第二版");
    a.local.put("图.png", "\u0000PNG");
    await a.engine.sync();
    /* 紧跟着的下一轮，读分支头读到了上一轮之前的值 */
    remote.stale = { sha: old, times: 10 };
    await a.engine.sync();
    expect(a.local.text("卡.md")).toBe("第二版");
    expect(a.local.text("图.png")).toBe("\u0000PNG");
    expect(a.state.head).not.toBe(old);
    expect(a.state.skips[a.state.skips.length - 1]).toMatchObject({ why: "stale" });
    /* 缓存过期后照常同步，云端两篇都在 */
    remote.stale = undefined;
    a.local.put("卡.md", "第三版");
    await a.engine.sync();
    expect(await remote.textAtHead("卡.md")).toBe("第三版");
    expect(await remote.textAtHead("图.png")).toBe("\u0000PNG");
  });
});

describe("外部进程刚写完，Obsidian 还没察觉", () => {
  it("取回时本地刚被改过：不盖掉，下一轮两边合在一起", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("卡.md", "甲\n\n乙\n\n丙");
    await a.engine.sync();
    await b.engine.sync();
    b.local.put("卡.md", "甲\n\n乙\n\n丙\n\n丁");
    await b.engine.sync();
    /* AI 会话在 a 上直接写磁盘，Obsidian 的修改时间和大小还是旧的 */
    a.local.external("卡.md", "零\n\n甲\n\n乙\n\n丙");
    await a.engine.sync();
    expect(a.local.text("卡.md")).toBe("零\n\n甲\n\n乙\n\n丙");
    expect(a.state.skips[a.state.skips.length - 1]).toMatchObject({ path: "卡.md", why: "changed" });
    a.local.notice();
    await a.engine.sync();
    expect(a.local.text("卡.md")).toBe("零\n\n甲\n\n乙\n\n丙\n\n丁");
    expect(await remote.textAtHead("卡.md")).toBe("零\n\n甲\n\n乙\n\n丙\n\n丁");
  });

  it("外部刚建的篇还没列出来、云端有同名的：不盖掉，合不了的记进两边都改了", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    b.local.put("新.md", "手机写的");
    await b.engine.sync();
    a.local.external("新.md", "AI 写的");
    await a.engine.sync();
    expect(a.local.text("新.md")).toBe("AI 写的");
    a.local.notice();
    await a.engine.sync();
    const text = a.local.text("新.md") as string;
    /* 合不了的用较新的那版，另一版进冲突记录，不静默丢掉 */
    expect(text).toBe("AI 写的");
    expect(a.state.clashes.map((c) => c.path)).toEqual(["新.md"]);
    expect(a.state.clashes[0].loser).toBe("手机写的");
  });

  it("云端删了、本地刚被外部改过：不丢进回收站", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("卡.md", "原文");
    await a.engine.sync();
    await b.engine.sync();
    b.local.files.delete("卡.md");
    await b.engine.sync();
    a.local.external("卡.md", "原文\n刚补的一行");
    await a.engine.sync();
    expect(a.local.text("卡.md")).toBe("原文\n刚补的一行");
    a.local.notice();
    await a.engine.sync();
    expect(await remote.textAtHead("卡.md")).toBe("原文\n刚补的一行");
  });
});

describe("同一时间只跑一轮", () => {
  it("同一个引擎同时叫两次：第二轮等第一轮跑完才开始", async () => {
    const a = device("Mac");
    a.local.put("x.md", "1");
    const seen: string[] = [];
    remote.onHead = () => seen.push(`head@${remote.headSha}`);
    await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(`head@${remote.headSha}`);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("插件重载留下的旧引擎和新引擎同时跑：也排队", async () => {
    const a = device("Mac");
    const again = device("Mac", a);
    a.local.put("x.md", "1");
    let active = 0;
    let most = 0;
    remote.onHead = () => {
      active++;
      most = Math.max(most, active);
    };
    const done = () => {
      active--;
    };
    await Promise.all([a.engine.sync().then(done), again.engine.sync().then(done)]);
    expect(most).toBe(1);
  });
});
