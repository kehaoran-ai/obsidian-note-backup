/**
 * [INPUT]: core 的 Engine / SyncLog，fakes 的内存笔记库与云端
 * [OUTPUT]: 同步引擎的行为测试：备份、取回、冲突三层、第二台设备合并、删除、我和 AI 拆条、抢先备份重试
 * [POS]: 单测主战场，对应任务卡的交付目标 2、3
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine";
import { SyncLog } from "../../src/core/log";
import { emptyState, type Who } from "../../src/core/types";
import { MemLocal, MemRemote } from "./fakes";

let clock: { t: number };
let remote: MemRemote;

function device(dev: string, defaultWho: Who = "ai") {
  const local = new MemLocal(clock);
  const log = new SyncLog();
  const state = emptyState();
  const engine = new Engine({ local, remote, log, device: () => dev, defaultWho, now: () => ++clock.t }, state);
  return { local, log, state, engine };
}

beforeEach(async () => {
  clock = { t: 1000 };
  remote = new MemRemote(clock);
  await remote.init();
});

describe("备份与取回", () => {
  it("第一次备份把所有笔记放上去，点开头的文件夹不放", async () => {
    const a = device("Mac");
    a.local.put("周计划.md", "# 周计划\n- 练腿");
    a.local.put("img/a.png", "\u0000PNG");
    a.local.put(".obsidian/app.json", "{}");
    const r = await a.engine.sync();
    expect(r.up.sort()).toEqual(["img/a.png", "周计划.md"]);
    expect(await remote.textAtHead("周计划.md")).toBe("# 周计划\n- 练腿");
    expect(await remote.textAtHead(".obsidian/app.json")).toBeUndefined();
    expect(await a.engine.pending()).toEqual([]);
    expect(a.log.commits[0].files.map((f) => f.s)).toContain("新建");
  });

  it("另一台空设备取回全部；之后改动两边保持一样", async () => {
    const a = device("Mac");
    const b = device("iPhone", "me");
    a.local.put("周计划.md", "# 周计划\n- 练腿");
    await a.engine.sync();
    const r = await b.engine.sync();
    expect(r.down).toEqual(["周计划.md"]);
    expect(b.local.text("周计划.md")).toBe("# 周计划\n- 练腿");

    b.local.put("周计划.md", "# 周计划\n- 练腿\n- 练背");
    await b.engine.sync();
    await a.engine.sync();
    expect(a.local.text("周计划.md")).toBe("# 周计划\n- 练腿\n- 练背");
    /* a 读到了 b 的记录，谁改的、哪台设备都在 */
    const v = a.log.versions("周计划.md")[0];
    expect(v).toMatchObject({ who: "me", dev: "iPhone", s: "+ 练背" });
  });

  it("没有改动时不做新的备份", async () => {
    const a = device("Mac");
    a.local.put("x.md", "1");
    await a.engine.sync();
    const head = remote.headSha;
    const r = await a.engine.sync();
    expect(r.commits).toEqual([]);
    expect(remote.headSha).toBe(head);
  });

  it("没变的笔记不读；变了的只读一次", async () => {
    const a = device("Mac");
    a.local.put("x.md", "1");
    a.local.put("y.md", "2");
    await a.engine.sync();
    const reads: string[] = [];
    a.local.onRead = (p) => reads.push(p);
    a.local.put("y.md", "22");
    await a.engine.sync();
    /* 扫描读一次，上传直接用扫描读到的内容 */
    expect(reads).toEqual(["y.md"]);
  });
});

describe("删除", () => {
  it("一边删了，另一边也删", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("x.md", "1");
    await a.engine.sync();
    await b.engine.sync();
    a.local.files.delete("x.md");
    await a.engine.sync();
    const r = await b.engine.sync();
    expect(r.removedLocal).toEqual(["x.md"]);
    expect(b.local.text("x.md")).toBeUndefined();
  });

  it("一边删了、另一边改了：留改了的，不丢", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("x.md", "1");
    await a.engine.sync();
    await b.engine.sync();
    a.local.files.delete("x.md");
    await a.engine.sync();
    b.local.put("x.md", "1 改过");
    await b.engine.sync();
    expect(b.local.text("x.md")).toBe("1 改过");
    expect(await remote.textAtHead("x.md")).toBe("1 改过");
    await a.engine.sync();
    expect(a.local.text("x.md")).toBe("1 改过");
  });
});

describe("冲突三层", () => {
  const BASE = "# 周计划\n\n- P-193 周五开写\n\n- 录视频\n\n- 练腿";

  async function twoDevices() {
    const a = device("Mac");
    const b = device("iPhone", "me");
    a.local.put("周计划.md", BASE);
    await a.engine.sync();
    await b.engine.sync();
    return { a, b };
  }

  it("第 1 层：不同段落两边都留，不亮黄点", async () => {
    const { a, b } = await twoDevices();
    a.local.put("周计划.md", BASE.replace("周五开写", "周四开写"));
    b.local.put("周计划.md", BASE.replace("练腿", "练腿练背"));
    await b.engine.sync();
    const r = await a.engine.sync();
    const want = "# 周计划\n\n- P-193 周四开写\n\n- 录视频\n\n- 练腿练背";
    expect(a.local.text("周计划.md")).toBe(want);
    expect(await remote.textAtHead("周计划.md")).toBe(want);
    expect(r.clashes).toEqual([]);
    expect(a.state.clashes).toEqual([]);
    await b.engine.sync();
    expect(b.local.text("周计划.md")).toBe(want);
  });

  it("第 2 层：同一段两边改得不一样，用修改时间较新的；本地较新时盖掉云端，云端那版本来就在历史里", async () => {
    const { a, b } = await twoDevices();
    b.local.put("周计划.md", BASE.replace("周五开写", "周三开写"));
    await b.engine.sync();
    a.local.put("周计划.md", BASE.replace("周五开写", "周四开写").replace("练腿", "练腿练背"));
    const r = await a.engine.sync();
    expect(a.local.text("周计划.md")).toBe(BASE.replace("周五开写", "周四开写").replace("练腿", "练腿练背"));
    expect(r.clashes).toHaveLength(1);
    expect(r.clashes[0]).toMatchObject({ path: "周计划.md", count: 1, loserLabel: { dev: "iPhone" }, winnerLabel: { dev: "Mac" } });
    expect(r.clashes[0].loser).toContain("周三开写");
    expect(a.state.clashes).toHaveLength(1);
  });

  it("第 2 层：云端较新时用云端的；本地被盖掉的那版先备份进历史，不丢", async () => {
    const { a, b } = await twoDevices();
    a.local.put("周计划.md", BASE.replace("周五开写", "周四开写").replace("练腿", "练腿练背"));
    b.local.put("周计划.md", BASE.replace("周五开写", "周三开写"));
    await b.engine.sync();
    const r = await a.engine.sync();
    /* 合不了的那处用云端(较新)；本地另一段的改动自动合进来 */
    const want = BASE.replace("周五开写", "周三开写").replace("练腿", "练腿练背");
    expect(a.local.text("周计划.md")).toBe(want);
    expect(await remote.textAtHead("周计划.md")).toBe(want);
    const lost = r.commits.flatMap((c) => c.files).find((f) => f.k === "lost");
    expect(lost?.s).toBe("改了同 1 处 · 被盖掉了");
    expect(new TextDecoder().decode(remote.blobs.get(lost?.h as string))).toContain("周四开写");
    expect(r.clashes[0]).toMatchObject({ winnerLabel: { dev: "iPhone" }, loserLabel: { dev: "Mac" } });
  });

  it("附件两边都改了：整份用较新的，旧的留在历史", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("a.png", "\u0000v1");
    await a.engine.sync();
    await b.engine.sync();
    a.local.put("a.png", "\u0000mac");
    b.local.put("a.png", "\u0000phone");
    await b.engine.sync();
    const r = await a.engine.sync();
    expect(a.local.text("a.png")).toBe("\u0000phone");
    expect(r.clashes[0]).toMatchObject({ binary: true });
    expect(remote.blobs.get(r.clashes[0].loser)).toBeDefined();
  });
});

describe("第二台设备已有笔记：两边合在一起，不删任何一篇", () => {
  it("只在一边有的两边都留，同名的按冲突规则合", async () => {
    const a = device("Mac");
    a.local.put("只在电脑.md", "a");
    a.local.put("同名.md", "# 同名\n电脑写的一段\n\n共同的一段");
    a.local.put("一样.md", "same");
    await a.engine.sync();

    const b = device("iPhone", "me");
    b.local.put("只在手机.md", "b");
    b.local.put("同名.md", "# 同名\n\n共同的一段\n\n手机写的一段");
    b.local.put("一样.md", "same");
    const r = await b.engine.sync();
    expect([...b.local.files.keys()].sort()).toEqual(["一样.md", "只在手机.md", "只在电脑.md", "同名.md"]);
    expect(b.local.text("同名.md")).toContain("电脑写的一段");
    expect(b.local.text("同名.md")).toContain("手机写的一段");
    expect(r.removedLocal).toEqual([]);
    expect(r.removedRemote).toEqual([]);
    await a.engine.sync();
    expect(a.local.text("只在手机.md")).toBe("b");
    expect(a.local.text("同名.md")).toBe(b.local.text("同名.md"));
  });
});

describe("我和 AI", () => {
  it("一次备份里既有我又有 AI：拆成两条", async () => {
    const a = device("Mac");
    a.local.put("周计划.md", "1");
    a.local.put("P-193.md", "1");
    a.state.who["周计划.md"] = "me";
    const r = await a.engine.sync();
    expect(r.commits.map((c) => c.who)).toEqual(["me", "ai"]);
    expect(r.commits[0].files.map((f) => f.p)).toEqual(["周计划.md"]);
    expect(r.commits[1].files.map((f) => f.p)).toEqual(["P-193.md"]);
    expect(a.state.who).toEqual({});
  });
});

describe("并发", () => {
  it("备份时别的设备抢先了：重来一轮，两边的改动都在", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("x.md", "1");
    await a.engine.sync();
    await b.engine.sync();
    a.local.put("a.md", "from a");
    remote.beforeMove = async () => {
      b.local.put("b.md", "from b");
      await b.engine.sync();
    };
    await a.engine.sync();
    expect(a.local.text("b.md")).toBe("from b");
    expect(await remote.textAtHead("a.md")).toBe("from a");
    expect(await remote.textAtHead("b.md")).toBe("from b");
  });

  it("取回时本地刚好又改了：不覆盖，下次再合", async () => {
    const a = device("Mac");
    const b = device("iPhone");
    a.local.put("x.md", "line1\n\nline2");
    await a.engine.sync();
    await b.engine.sync();
    a.local.put("x.md", "line1 a\n\nline2");
    await a.engine.sync();
    /* b 扫描完、写回之前，用户又改了 */
    remote.beforeMove = undefined;
    const origStat = b.local.stat.bind(b.local);
    let once = true;
    b.local.stat = async (p) => {
      if (once) {
        once = false;
        b.local.put("x.md", "line1\n\nline2 b");
      }
      return origStat(p);
    };
    await b.engine.sync();
    expect(b.local.text("x.md")).toBe("line1\n\nline2 b");
    b.local.stat = origStat;
    await b.engine.sync();
    expect(b.local.text("x.md")).toBe("line1 a\n\nline2 b");
  });
});

describe("指纹缓存慢一拍", () => {
  it("内容变了但修改时间和大小没变：上传前按真内容核对，不重复备份", async () => {
    const a = device("Mac");
    a.local.put("x.md", "周四");
    await a.engine.sync();
    const m = a.local.files.get("x.md")?.mtime as number;
    /* 同样字节数的改动，修改时间也没变：缓存会以为没变 */
    a.local.put("x.md", "周六", m);
    a.state.hashes["x.md"].h = "stale";
    a.local.put("x.md", "周四", m);
    const r = await a.engine.sync();
    expect(r.commits).toEqual([]);
    expect(a.state.hashes["x.md"].h).toBe(a.state.base["x.md"]);
  });
});

describe("安全", () => {
  it("云端里带 ../ 或点开头的路径不写进笔记库", async () => {
    const a = device("Mac");
    const head = remote.headSha as string;
    const evil = await remote.writeCommit(head, `t:${head}`, [
      { path: "../逃出去.md", data: new TextEncoder().encode("x") },
      { path: ".git/config", data: new TextEncoder().encode("x") },
      { path: "a/../../b.md", data: new TextEncoder().encode("x") },
      { path: "正常.md", data: new TextEncoder().encode("ok") },
    ], "外部提交");
    await remote.moveHead(evil.commit, head);
    const r = await a.engine.sync();
    expect(r.down).toEqual(["正常.md"]);
    expect([...a.local.files.keys()]).toEqual(["正常.md"]);
  });
});
