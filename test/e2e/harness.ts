/**
 * [INPUT]: Node fs(只在电脑版 Obsidian 的渲染进程里跑)，core 的 Engine / RemoteStore 契约
 * [OUTPUT]: window.NBHarness：FileRemote(放在本机文件夹里的假云端，两个测试实例共用)与 plug(把插件接到假云端)
 * [POS]: 端到端测试的替身。真 GitHub 接口由 test/github 覆盖；这里只验插件界面 + 笔记库 + 引擎的整条链，不碰任何登录凭证
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { gitBlobSha } from "../../src/core/bytes";
import { Engine, Stopped } from "../../src/core/engine";
import type { FileChange, RemoteCommit, RemoteStore } from "../../src/core/types";
import { VaultStore } from "../../src/obsidian/vault-store";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = (window as unknown as { require: (m: string) => typeof import("fs") }).require("fs");

interface Commit {
  parent: string | null;
  tree: Record<string, string>;
  message: string;
  time: number;
}

class FileRemote implements RemoteStore {
  constructor(private dir: string) {
    fs.mkdirSync(`${dir}/blobs`, { recursive: true });
    fs.mkdirSync(`${dir}/commits`, { recursive: true });
    if (!fs.existsSync(`${dir}/head`)) {
      const sha = this.put({}, "笔记备份：建好了", null);
      fs.writeFileSync(`${dir}/head`, sha);
    }
  }
  private put(tree: Record<string, string>, message: string, parent: string | null) {
    const sha = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(`${this.dir}/commits/${sha}.json`, JSON.stringify({ parent, tree, message, time: Date.now() }));
    return sha;
  }
  private commit(sha: string): Commit {
    return JSON.parse(fs.readFileSync(`${this.dir}/commits/${sha}.json`, "utf8"));
  }
  async head() {
    if (this.stale && this.stale.times-- > 0) return this.stale.sha;
    return this.realHead();
  }
  realHead() {
    return fs.readFileSync(`${this.dir}/head`, "utf8").trim();
  }
  async tree(commit: string) {
    return { tree: `t:${commit}`, files: { ...this.commit(commit).tree } };
  }
  async readBlob(sha: string) {
    return new Uint8Array(fs.readFileSync(`${this.dir}/blobs/${sha}`));
  }
  /** 每篇故意慢几毫秒，好在端到端里点得到暂停 */
  delay = 0;
  async writeCommit(parent: string, parentTree: string, changes: FileChange[], message: string, onProgress?: (n: number) => void, signal?: AbortSignal) {
    const tree = { ...this.commit(parentTree.slice(2)).tree };
    let n = 0;
    for (const c of changes) {
      if (signal?.aborted) throw new Stopped();
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      if (c.data) {
        const sha = await gitBlobSha(c.data);
        fs.writeFileSync(`${this.dir}/blobs/${sha}`, c.data);
        tree[c.path] = sha;
      } else delete tree[c.path];
      onProgress?.(++n);
    }
    const sha = this.put(tree, message, parent);
    return { commit: sha, tree: `t:${sha}` };
  }
  /** 测试钩子：接下来几次读分支头读到这个旧值，模拟 GitHub 接口 60 秒缓存 */
  stale: { sha: string; times: number } | null = null;
  async isBehind(sha: string, than: string) {
    let c: string | null = this.commit(than).parent;
    while (c && c !== sha) c = this.commit(c).parent;
    return c === sha;
  }
  async moveHead(to: string, from: string) {
    if (this.realHead() !== from) return false;
    fs.writeFileSync(`${this.dir}/head`, to);
    return true;
  }
  async history(head: string, known: Set<string>): Promise<RemoteCommit[]> {
    const out: RemoteCommit[] = [];
    let c: string | null = head;
    while (c && !known.has(c)) {
      const cm = this.commit(c);
      out.push({ sha: c, time: cm.time, message: cm.message });
      c = cm.parent;
    }
    return out;
  }
}

/** 把插件接到假云端：等同于登录成功后 attach 的结果 */
async function plug(plugin: any, dir: string, device: string, defaultWho: "me" | "ai" = "ai") {
  plugin.settings.account = { login: "test-user", owner: "test-user", repo: "file-remote", branch: "main" };
  plugin.settings.device = device;
  await plugin.saveSettings();
  plugin.remote = new FileRemote(dir);
  plugin.engine = new Engine(
    {
      local: new VaultStore(plugin.app, (p: string) => plugin.markOwnWrite(p)),
      remote: plugin.remote,
      log: plugin.log,
      device: () => plugin.settings.device,
      defaultWho,
      checkpoint: () => plugin.saveState(),
      lock: `harness:${plugin.app.vault.getName()}`,
    },
    plugin.state,
  );
  plugin.refreshStatus();
}

(window as unknown as { NBHarness: unknown }).NBHarness = { FileRemote, plug };
