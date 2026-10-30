/**
 * [INPUT]: 环境变量 NB_TEST_TOKEN(跑之前从 `gh auth token` 临时取，不落盘)、NB_TEST_REPO(默认 note-backup-test-p193)
 * [OUTPUT]: 对真 GitHub 的集成测试：建私有备份、第一次备份、第二台设备取回、冲突、读到旧分支头不写、读回记录
 * [POS]: 证明 github/remote 对真接口可用；只写私有测试仓库，不碰正式备份
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { describe, expect, it } from "vitest";
import { gitBlobSha } from "../../src/core/bytes";
import { Engine } from "../../src/core/engine";
import { SyncLog } from "../../src/core/log";
import { emptyState, type Who } from "../../src/core/types";
import { GitHubApi, type Http } from "../../src/github/api";
import { whoami } from "../../src/github/auth";
import { findExisting } from "../../src/github/existing";
import { describeBackup, openBackup } from "../../src/github/remote";
import { MemLocal } from "../unit/fakes";

const token = process.env.NB_TEST_TOKEN;
const repoName = process.env.NB_TEST_REPO ?? "note-backup-test-p193";

const http: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const buf = await res.arrayBuffer();
  return { status: res.status, text: new TextDecoder().decode(buf), arrayBuffer: buf };
};

describe.skipIf(!token)("真 GitHub", () => {
  it("备份、取回、冲突、记录全流程", { timeout: 180_000 }, async () => {
    const api = new GitHubApi(http, token as string);
    const owner = await whoami(api);
    const { remote } = await openBackup(api, owner, repoName);
    const clock = { t: Date.now() };
    const mk = (dev: string, who: Who) => {
      const local = new MemLocal(clock);
      const log = new SyncLog();
      const st = emptyState();
      return { local, log, st, engine: new Engine({ local, remote, log, device: () => dev, defaultWho: who }, st) };
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `run-${stamp}`;
    const a = mk("测试 Mac", "ai");
    a.local.put(`${dir}/周计划.md`, "# 周计划\n\n- 周五开写\n\n- 练腿\n");
    a.local.put(`${dir}/带 BOM.md`, "﻿# bom\r\nwindows 换行\r\n");
    a.local.put(`${dir}/图片.png`, "\u0000\u0001PNG 假图");
    a.local.put(`${dir}/.hidden/x.md`, "不该上去");
    a.st.who[`${dir}/周计划.md`] = "me";
    const r1 = await a.engine.sync();
    expect(r1.up).toHaveLength(3);
    expect(r1.commits.map((c) => c.who)).toEqual(["me", "ai"]);

    /* 本地算的指纹和 GitHub 存下的一致(文本直接塞进建树请求也不走样) */
    const head = (await remote.head()) as string;
    const { files } = await remote.tree(head);
    for (const p of [`${dir}/周计划.md`, `${dir}/带 BOM.md`, `${dir}/图片.png`]) {
      expect(files[p]).toBe(await gitBlobSha(a.local.files.get(p)?.data as Uint8Array));
    }
    expect(files[`${dir}/.hidden/x.md`]).toBeUndefined();

    /* 第二台设备：取回，读到同一份记录 */
    const b = mk("测试 iPhone", "me");
    const r2 = await b.engine.sync();
    expect(r2.down).toEqual(expect.arrayContaining([`${dir}/周计划.md`, `${dir}/图片.png`]));
    expect(b.local.text(`${dir}/周计划.md`)).toBe("# 周计划\n\n- 周五开写\n\n- 练腿\n");
    expect(b.log.versions(`${dir}/周计划.md`)[0]).toMatchObject({ who: "me", dev: "测试 Mac", s: "新建" });

    /* 冲突：手机较新，同一处改得不一样；电脑另一段的改动自动合进来 */
    a.local.put(`${dir}/周计划.md`, "# 周计划\n\n- 周四开写\n\n- 练腿练背\n", clock.t + 1);
    b.local.put(`${dir}/周计划.md`, "# 周计划\n\n- 周三开写\n\n- 练腿\n", clock.t + 100);
    await b.engine.sync();
    const r3 = await a.engine.sync();
    expect(r3.clashes).toHaveLength(1);
    expect(a.local.text(`${dir}/周计划.md`)).toBe("# 周计划\n\n- 周三开写\n\n- 练腿练背\n");
    const lost = r3.commits.flatMap((c) => c.files).find((f) => f.k === "lost");
    expect(new TextDecoder().decode(await remote.readBlob(lost?.h as string))).toContain("周四开写");

    /* 两边追平 */
    await b.engine.sync();
    expect(b.local.text(`${dir}/周计划.md`)).toBe(a.local.text(`${dir}/周计划.md`));

    /* 读到的分支头是旧的：真 GitHub 认得出它是现在的祖先，反过来不算 */
    const now = (await remote.head()) as string;
    expect(await remote.isBehind(head, now)).toBe(true);
    expect(await remote.isBehind(now, head)).toBe(false);
    /* 旧分支头喂给已经追平的 a：整轮不写，本地不被改回 */
    const before = a.local.text(`${dir}/周计划.md`);
    const realHead = remote.head.bind(remote);
    remote.head = async () => head;
    const r5 = await a.engine.sync();
    remote.head = realHead;
    expect(r5.stale).toBe(true);
    expect(a.local.text(`${dir}/周计划.md`)).toBe(before);
    expect(a.local.text(`${dir}/图片.png`)).toBe("\u0000\u0001PNG 假图");

    const d = await describeBackup(remote);
    expect(d?.count).toBeGreaterThanOrEqual(3);

    /* 认出已有备份：.git/config 指着这个仓库；本地已经有同样的笔记，接上后一篇不重传 */
    const ex = await findExisting(api, `[remote "origin"]\n\turl = https://github.com/${owner}/${repoName}.git\n`);
    expect(ex?.kind).toBe("ok");
    if (ex?.kind !== "ok") throw new Error("没认出");
    expect(ex.full).toBe(`${owner}/${repoName}`);
    const c = mk("测试 第三台", "me");
    for (const [p, f] of b.local.files) c.local.files.set(p, f);
    const r4 = await new Engine({ local: c.local, remote: ex.remote, log: c.log, device: () => "测试 第三台", defaultWho: "me" }, c.st).sync();
    expect(r4.commits).toEqual([]);
    expect(r4.clashes).toEqual([]);
    /* 不是自己能写的仓库不认 */
    expect(await findExisting(api, `[remote "origin"]\n\turl = https://github.com/torvalds/linux.git\n`)).toBeNull();
  });
});
