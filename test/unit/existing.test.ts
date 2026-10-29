/**
 * [INPUT]: github/existing 的 parseGitRemote，core 的 Engine
 * [OUTPUT]: 认出已有备份的测试：各种 .git/config 写法、接上已有仓库时一篇不重传
 * [POS]: 单测，对应老板 2026-10-29 拍板的「用户已有仓库就接着用」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine";
import { SyncLog } from "../../src/core/log";
import { emptyState } from "../../src/core/types";
import { GitHubApi } from "../../src/github/api";
import { findExisting, parseGitRemote } from "../../src/github/existing";
import { MemLocal, MemRemote } from "./fakes";

const cfg = (url: string, name = "origin") => `[core]\n\tbare = false\n[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;

describe("parseGitRemote", () => {
  it("认得 https、ssh、带 .git、带账号的写法", () => {
    expect(parseGitRemote(cfg("https://github.com/haoran-product/haoran-vault.git"))).toEqual({ owner: "haoran-product", repo: "haoran-vault" });
    expect(parseGitRemote(cfg("https://github.com/a/b"))).toEqual({ owner: "a", repo: "b" });
    expect(parseGitRemote(cfg("git@github.com:a/b.git"))).toEqual({ owner: "a", repo: "b" });
    expect(parseGitRemote(cfg("ssh://git@github.com/a/b.git"))).toEqual({ owner: "a", repo: "b" });
    expect(parseGitRemote(cfg("https://user:ghp_secret@github.com/a/b.git"))).toEqual({ owner: "a", repo: "b" });
  });
  it("不是 GitHub、不是 origin、没有远端的都不认", () => {
    expect(parseGitRemote(cfg("https://gitlab.com/a/b.git"))).toBeNull();
    expect(parseGitRemote(cfg("https://github.com/a/b.git", "upstream"))).toBeNull();
    expect(parseGitRemote("[core]\n\tbare = false\n")).toBeNull();
  });
});

describe("接上已有仓库", () => {
  it("本地和仓库一样的篇一篇不传、不写；只在一边的两边补齐", async () => {
    const clock = { t: 1 };
    const remote = new MemRemote(clock);
    await remote.init();
    /* 别的软件(Obsidian Git)早就备份过 */
    const old = new MemLocal(clock);
    old.put("a.md", "A");
    old.put("b.md", "B");
    await new Engine({ local: old, remote, log: new SyncLog(), device: () => "x", defaultWho: "ai" }, emptyState()).sync();
    const local = new MemLocal(clock);
    local.put("a.md", "A");
    local.put("b.md", "B");
    local.put("新写的.md", "N");
    let reads = 0;
    local.onRead = () => reads++;
    const r = await new Engine({ local, remote, log: new SyncLog(), device: () => "Mac", defaultWho: "me" }, emptyState()).sync();
    expect(r.down).toEqual([]);
    expect(r.up).toEqual(["新写的.md"]);
    expect(r.clashes).toEqual([]);
    expect(reads).toBe(3);
  });
});

describe("findExisting", () => {
  const api = (routes: Record<string, { status: number; body: unknown }>) =>
    new GitHubApi(async (req) => {
      const path = req.url.replace("https://api.github.com", "");
      const r = routes[path] ?? { status: 404, body: { message: "Not Found" } };
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return { status: r.status, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
    }, "t");
  const conf = cfg("https://github.com/haoran-product/haoran-vault.git");

  it("组织开了第三方应用限制(403)：明说被挡", async () => {
    const r = await findExisting(api({ "/repos/haoran-product/haoran-vault": { status: 403, body: { message: "Although you appear to have the correct authorization credentials, the `haoran-product` organization has enabled OAuth App access restrictions" } } }), conf);
    expect(r).toEqual({ kind: "blocked", org: "haoran-product", full: "haoran-product/haoran-vault" });
  });
  it("组织里的读不到(404)：也当被挡；个人账号下读不到：当作没有", async () => {
    expect((await findExisting(api({ "/users/haoran-product": { status: 200, body: { type: "Organization" } } }), conf))?.kind).toBe("blocked");
    expect(await findExisting(api({ "/users/a": { status: 200, body: { type: "User" } } }), cfg("https://github.com/a/b.git"))).toBeNull();
  });
  it("公开的、只读的不接", async () => {
    const pub = { "/repos/haoran-product/haoran-vault": { status: 200, body: { full_name: "haoran-product/haoran-vault", private: false, default_branch: "main", permissions: { push: true } } } };
    const ro = { "/repos/haoran-product/haoran-vault": { status: 200, body: { full_name: "haoran-product/haoran-vault", private: true, default_branch: "main", permissions: { push: false } } } };
    expect(await findExisting(api(pub), conf)).toBeNull();
    expect(await findExisting(api(ro), conf)).toBeNull();
  });
  it("能写的私有仓库：接着用", async () => {
    const ok = {
      "/repos/haoran-product/haoran-vault": { status: 200, body: { full_name: "haoran-product/haoran-vault", private: true, default_branch: "main", permissions: { push: true } } },
      "/repos/haoran-product/haoran-vault/git/ref/heads/main": { status: 200, body: { object: { sha: "abc" } } },
    };
    const r = await findExisting(api(ok), conf);
    expect(r?.kind).toBe("ok");
  });
});
