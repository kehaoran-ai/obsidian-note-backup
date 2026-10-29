/**
 * [INPUT]: core/ignore 的 makeIgnore，core/engine，github/api 的限流重试
 * [OUTPUT]: .gitignore 过滤、密钥文件夹永远不上传、GitHub 限流等待重试的测试
 * [POS]: 单测，接主力笔记库前的安全兜底
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine";
import { makeIgnore } from "../../src/core/ignore";
import { SyncLog } from "../../src/core/log";
import { emptyState } from "../../src/core/types";
import { GitHubApi } from "../../src/github/api";
import { MemLocal, MemRemote } from "./fakes";

/* 老板主力笔记库 .gitignore 里和笔记有关的几行(2026-10-29 原样) */
const VAULT = ["node_modules/", "_l2-html/", "**/敏感信息/", "**/sensitive/", "logs/", "**/__pycache__/", "03-资源/图片/UINice设计系统审阅/"].join("\n");

describe("makeIgnore", () => {
  const ig = makeIgnore(VAULT);
  it("按老板笔记库的规则跳过", () => {
    expect(ig("01-项目/x/敏感信息/key.md")).toBe(true);
    expect(ig("敏感信息/a.md")).toBe(true);
    expect(ig("01-项目/代码-UINice/node_modules/a/index.js")).toBe(true);
    expect(ig("03-资源/图片/UINice设计系统审阅/1.png")).toBe(true);
    expect(ig("a/b/logs/x.txt")).toBe(true);
    expect(ig("01-项目/周计划.md")).toBe(false);
    expect(ig("03-资源/图片/别的/1.png")).toBe(false);
    expect(ig("logs.md")).toBe(false);
  });
  it("密钥文件夹 .gitignore 写了 ! 也放不开；没有 .gitignore 也挡", () => {
    expect(makeIgnore("!敏感信息/")("敏感信息/a.md")).toBe(true);
    expect(makeIgnore("")("x/secrets/a.json")).toBe(true);
    expect(makeIgnore("")("prod.env")).toBe(true);
  });
  it("常用写法：根目录锚定、* 、否定", () => {
    const g = makeIgnore("/build\n*.log\n!keep.log\ndocs/*.tmp");
    expect(g("build/a.js")).toBe(true);
    expect(g("src/build/a.js")).toBe(false);
    expect(g("a/b.log")).toBe(true);
    expect(g("keep.log")).toBe(false);
    expect(g("docs/x.tmp")).toBe(true);
    expect(g("docs/sub/x.tmp")).toBe(false);
  });
});

describe("引擎按规则跳过", () => {
  it("跳过的不上传；规则后加的，已备份的不被当成删除", async () => {
    const clock = { t: 1 };
    const remote = new MemRemote(clock);
    await remote.init();
    const local = new MemLocal(clock);
    let rules = "";
    const engine = new Engine(
      { local, remote, log: new SyncLog(), device: () => "Mac", defaultWho: "ai", ignore: (p) => makeIgnore(rules)(p) },
      emptyState(),
    );
    local.put("敏感信息/token.md", "ghp_xxx");
    local.put("草稿/a.md", "a");
    local.put("笔记.md", "n");
    await engine.sync();
    expect(await remote.textAtHead("敏感信息/token.md")).toBeUndefined();
    expect(await remote.textAtHead("草稿/a.md")).toBe("a");
    rules = "草稿/";
    const r = await engine.sync();
    expect(r.removedRemote).toEqual([]);
    expect(await remote.textAtHead("草稿/a.md")).toBe("a");
    expect(local.text("草稿/a.md")).toBe("a");
    expect(await engine.pending()).toEqual([]);
  });
});

describe("GitHub 限流", () => {
  it("403 限流按 Retry-After 等一下再试", async () => {
    let n = 0;
    const waits: number[] = [];
    const api = new GitHubApi(async () => {
      n++;
      return n === 1
        ? { status: 403, text: "secondary rate limit", arrayBuffer: new ArrayBuffer(0), headers: { "retry-after": "2" } }
        : { status: 200, text: '{"ok":1}', arrayBuffer: new ArrayBuffer(0) };
    }, "t");
    api.sleep = async (ms) => void waits.push(ms);
    expect(await api.json("POST", "/x", {})).toEqual({ ok: 1 });
    expect(waits).toEqual([2000]);
  });
});
