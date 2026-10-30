/**
 * [INPUT]: core 的 LocalStore / RemoteStore 契约
 * [OUTPUT]: MemLocal 内存笔记库(能模拟 Obsidian 没察觉的外部写入)、MemRemote 内存云端(行为照 GitHub：只快进、内容指纹同 git，能模拟分支头读到旧值)
 * [POS]: 单测的替身，让引擎不连网、不开 Obsidian 也能跑完整流程
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { gitBlobSha, utf8 } from "../../src/core/bytes";
import { Stopped } from "../../src/core/engine";
import type { FileChange, LocalEntry, LocalStore, RemoteCommit, RemoteStore } from "../../src/core/types";

export class MemLocal implements LocalStore {
  /** 磁盘上真实的样子 */
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  /**
   * Obsidian 还没察觉的外部写入：list / stat 照旧报这里记的老样子(null 是还没列出来)，
   * 和 TFile.stat 一样慢一拍；read / peek 读的是磁盘，是新的
   */
  lag = new Map<string, LocalEntry | null>();
  constructor(public clock: { t: number }) {}
  /** 外部进程(AI 会话、git)直接写磁盘，Obsidian 还没察觉；text 为 null 是删掉 */
  external(path: string, text: string | null) {
    if (!this.lag.has(path)) {
      const f = this.files.get(path);
      this.lag.set(path, f ? { path, mtime: f.mtime, size: f.data.byteLength } : null);
    }
    if (text === null) this.files.delete(path);
    else this.files.set(path, { data: utf8(text), mtime: ++this.clock.t });
  }
  /** Obsidian 察觉了外部写入 */
  notice() {
    this.lag.clear();
  }
  private entry(path: string): LocalEntry | null {
    if (this.lag.has(path)) return this.lag.get(path) ?? null;
    const f = this.files.get(path);
    return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
  }
  put(path: string, text: string, mtime = ++this.clock.t) {
    this.files.set(path, { data: utf8(text), mtime });
  }
  text(path: string) {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }
  async list(): Promise<LocalEntry[]> {
    const paths = new Set([...this.files.keys(), ...this.lag.keys()]);
    return [...paths].map((p) => this.entry(p)).filter((e): e is LocalEntry => !!e);
  }
  async stat(path: string) {
    return this.entry(path);
  }
  async peek(path: string) {
    return this.files.get(path)?.data ?? null;
  }
  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error("no " + path);
    this.onRead?.(path);
    return f.data;
  }
  onRead?: (path: string) => void;
  /** 插件自己经 Obsidian 写的，Obsidian 马上知道 */
  async write(path: string, data: Uint8Array) {
    this.lag.delete(path);
    this.files.set(path, { data, mtime: ++this.clock.t });
  }
  async remove(path: string) {
    this.lag.delete(path);
    this.files.delete(path);
  }
}

interface Commit {
  parent: string | null;
  tree: Record<string, string>;
  message: string;
  time: number;
}

export class MemRemote implements RemoteStore {
  blobs = new Map<string, Uint8Array>();
  commits = new Map<string, Commit>();
  headSha: string | null = null;
  n = 0;
  /** 测试钩子：moveHead 之前插一脚，模拟别的设备抢先备份 */
  beforeMove?: () => Promise<void>;
  constructor(public clock: { t: number }) {}

  async put(tree: Record<string, string>, message: string, parent: string | null): Promise<string> {
    const sha = `c${++this.n}`;
    this.commits.set(sha, { parent, tree, message, time: ++this.clock.t });
    return sha;
  }
  /** 测试钩子：接下来几次读分支头读到这个旧值，模拟 GitHub 接口 60 秒缓存 */
  stale?: { sha: string; times: number };
  /** 测试钩子：每次读分支头记一笔，看两轮同步有没有叠在一起 */
  onHead?: () => void;
  async head() {
    this.onHead?.();
    if (this.stale && this.stale.times-- > 0) return this.stale.sha;
    return this.headSha;
  }
  async isBehind(sha: string, than: string) {
    let c: string | null = this.commits.get(than)?.parent ?? null;
    while (c && c !== sha) c = this.commits.get(c)?.parent ?? null;
    return c === sha;
  }
  async tree(commit: string) {
    const c = this.commits.get(commit);
    if (!c) throw new Error("no commit");
    return { tree: `t:${commit}`, files: { ...c.tree } };
  }
  async readBlob(sha: string) {
    const b = this.blobs.get(sha);
    if (!b) throw new Error("no blob " + sha);
    return b;
  }
  /** 测试钩子：第几次写提交时抛错，模拟断网 */
  failOnWrite?: number;
  writes = 0;
  async writeCommit(parent: string, parentTree: string, changes: FileChange[], message: string, _p?: (n: number) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new Stopped();
    if (++this.writes === this.failOnWrite) throw new Error("断网了");
    const base = this.commits.get(parentTree.slice(2));
    if (!base) throw new Error("bad tree " + parentTree);
    const tree = { ...base.tree };
    for (const c of changes) {
      if (c.data) {
        const sha = await gitBlobSha(c.data);
        this.blobs.set(sha, c.data);
        tree[c.path] = sha;
      } else delete tree[c.path];
    }
    const sha = await this.put(tree, message, parent);
    return { commit: sha, tree: `t:${sha}` };
  }
  async moveHead(to: string, from: string) {
    if (this.beforeMove) {
      const f = this.beforeMove;
      this.beforeMove = undefined;
      await f();
    }
    /* 只快进：to 的祖先里要有现在的 head */
    let c: string | null = to;
    while (c && c !== this.headSha) c = this.commits.get(c)?.parent ?? null;
    if (c !== this.headSha || this.headSha !== from) return false;
    this.headSha = to;
    return true;
  }
  async history(head: string, known: Set<string>): Promise<RemoteCommit[]> {
    const out: RemoteCommit[] = [];
    let c: string | null = head;
    while (c && !known.has(c)) {
      const cm = this.commits.get(c) as Commit;
      out.push({ sha: c, time: cm.time, message: cm.message });
      c = cm.parent;
    }
    return out;
  }
  async init() {
    this.headSha = await this.put({ ".notebackup/info.json": "x" }, "笔记备份：建好了", null);
  }
  async textAtHead(path: string) {
    const c = this.commits.get(this.headSha as string) as Commit;
    const sha = c.tree[path];
    return sha ? new TextDecoder().decode(this.blobs.get(sha)) : undefined;
  }
}
