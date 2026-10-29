/**
 * [INPUT]: api 的 GitHubApi，core 的 RemoteStore 契约与字节工具
 * [OUTPUT]: GitHubRemote 云端备份的读写(写内容主动限速、可在请求之间暂停)；openBackup 找到或新建「我的笔记备份」；describeBackup 已有备份的篇数和上次备份
 * [POS]: github 的存储层。纯 JavaScript 直连 GitHub 的 Git 数据接口，不依赖本机 Git，所以手机也能用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { asText, toBase64 } from "../core/bytes";
import { keepPath, Stopped } from "../core/engine";
import { decodeMessage } from "../core/log";
import type { FileChange, RemoteCommit, RemoteStore } from "../core/types";
import { ApiError, GitHubApi } from "./api";

/** GitHub 仓库名只认英文；界面上叫「我的笔记备份」 */
export const REPO_NAME = "obsidian-notes-backup";
const INIT_PATH = ".notebackup/info.json";
const INIT_MESSAGE = "笔记备份：建好了";
/* 一次建树最多带多少篇、多大，太大 GitHub 会超时 */
const BATCH_FILES = 200;
const BATCH_BYTES = 2 * 1024 * 1024;
/* 小于这个的文本直接塞进建树请求，省掉一篇一个请求 */
const INLINE_TEXT = 1024 * 1024;
/*
 * GitHub 对「写内容」的请求限流：每分钟约 80 次。先放 20 次不等，
 * 之后每 800 毫秒一次(每分钟 75 次)，第一次备份几百个附件也不会被挡。
 */
const BURST = 20;
const PACE_MS = 800;

interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha?: string | null;
  content?: string;
}

export class GitHubRemote implements RemoteStore {
  constructor(private api: GitHubApi, readonly owner: string, readonly repo: string, readonly branch: string) {}

  private tokens = BURST;
  private refilled = Date.now();
  /** 每次写内容之前排一下队；顺便看用户有没有点暂停 */
  private async pace(signal?: AbortSignal) {
    if (signal?.aborted) throw new Stopped();
    const now = Date.now();
    this.tokens = Math.min(BURST, this.tokens + (now - this.refilled) / PACE_MS);
    this.refilled = now;
    if (this.tokens < 1) {
      await new Promise((r) => setTimeout(r, (1 - this.tokens) * PACE_MS));
      this.tokens = 1;
      this.refilled = Date.now();
      if (signal?.aborted) throw new Stopped();
    }
    this.tokens -= 1;
  }

  private get R() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  async head(): Promise<string | null> {
    const ref = await this.api.json<{ object: { sha: string } }>("GET", `${this.R}/git/ref/heads/${this.branch}`, undefined, [404, 409]);
    return ref?.object.sha ?? null;
  }

  /** 空仓库没法用 Git 数据接口，先放一个说明文件做第一次备份 */
  async init(): Promise<void> {
    const info = { app: "笔记备份", note: "这里是 Obsidian 插件「笔记备份」自动维护的笔记备份。", at: new Date().toISOString() };
    await this.api.json("PUT", `${this.R}/contents/${INIT_PATH}`, {
      message: INIT_MESSAGE,
      content: toBase64(new TextEncoder().encode(JSON.stringify(info, null, 2) + "\n")),
    });
  }

  async tree(commit: string): Promise<{ tree: string; files: Record<string, string> }> {
    const c = await this.api.json<{ tree: { sha: string } }>("GET", `${this.R}/git/commits/${commit}`);
    const tree = (c as { tree: { sha: string } }).tree.sha;
    const t = await this.api.json<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(
      "GET",
      `${this.R}/git/trees/${tree}?recursive=1`,
    );
    if (!t) throw new Error("读不到云端备份");
    if (t.truncated) throw new Error("笔记太多，一次读不完");
    const files: Record<string, string> = {};
    for (const e of t.tree) if (e.type === "blob") files[e.path] = e.sha;
    return { tree, files };
  }

  readBlob(sha: string): Promise<Uint8Array> {
    return this.api.bytes(`${this.R}/git/blobs/${sha}`);
  }

  async writeCommit(parent: string, parentTree: string, changes: FileChange[], message: string, onProgress?: (done: number) => void, signal?: AbortSignal) {
    let base = parentTree;
    let batch: TreeEntry[] = [];
    let bytes = 0;
    let done = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.pace(signal);
      const t = await this.api.json<{ sha: string }>("POST", `${this.R}/git/trees`, { base_tree: base, tree: batch });
      base = (t as { sha: string }).sha;
      done += batch.length;
      batch = [];
      bytes = 0;
      onProgress?.(done);
    };
    for (const c of changes) {
      const entry: TreeEntry = { path: c.path, mode: "100644", type: "blob" };
      if (c.data === null) entry.sha = null;
      else {
        const text = c.data.byteLength < INLINE_TEXT ? asText(c.data) : null;
        if (text !== null) entry.content = text;
        else {
          await this.pace(signal);
          const b = await this.api.json<{ sha: string }>("POST", `${this.R}/git/blobs`, { content: toBase64(c.data), encoding: "base64" });
          entry.sha = (b as { sha: string }).sha;
        }
        bytes += c.data.byteLength;
      }
      batch.push(entry);
      if (batch.length >= BATCH_FILES || bytes >= BATCH_BYTES) await flush();
    }
    await flush();
    await this.pace(signal);
    const commit = await this.api.json<{ sha: string }>("POST", `${this.R}/git/commits`, { message, tree: base, parents: [parent] });
    return { commit: (commit as { sha: string }).sha, tree: base };
  }

  async moveHead(to: string, from: string): Promise<boolean> {
    void from;
    try {
      await this.api.json("PATCH", `${this.R}/git/refs/heads/${this.branch}`, { sha: to, force: false });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) return false;
      throw e;
    }
  }

  async history(head: string, known: Set<string>, maxPages: number): Promise<RemoteCommit[]> {
    const out: RemoteCommit[] = [];
    let foreign = 0;
    for (let page = 1; page <= maxPages; page++) {
      const list = await this.api.json<{ sha: string; commit: { message: string; committer: { date: string } } }[]>(
        "GET",
        `${this.R}/commits?sha=${head}&per_page=100&page=${page}`,
      );
      if (!list?.length) break;
      for (const c of list) {
        if (known.has(c.sha)) return out;
        const rc: RemoteCommit = { sha: c.sha, time: Date.parse(c.commit.committer.date), message: c.commit.message };
        /* 别的软件做的备份，单独读一次改了哪些篇(最多 30 个，太旧的不追) */
        if (!decodeMessage(rc) && c.commit.message !== INIT_MESSAGE && foreign++ < 30) {
          const d = await this.api.json<{ files?: { filename: string; status: string; sha: string }[] }>("GET", `${this.R}/commits/${c.sha}`);
          rc.files = (d?.files ?? []).map((f) => ({ path: f.filename, sha: f.status === "removed" ? null : f.sha, status: f.status }));
        }
        out.push(rc);
      }
      if (list.length < 100) break;
    }
    return out;
  }
}

/** 已有备份的概况：手机上「找到你的备份 · 418 篇笔记」 */
export async function describeBackup(remote: GitHubRemote): Promise<{ count: number; at: number; dev: string } | null> {
  const head = await remote.head();
  if (!head) return null;
  const { files } = await remote.tree(head);
  const count = Object.keys(files).filter(keepPath).length;
  if (!count) return null;
  const [last] = await remote.history(head, new Set(), 1);
  const meta = last ? decodeMessage(last) : null;
  return { count, at: last?.time ?? 0, dev: meta?.dev ?? "" };
}

export class PublicRepoError extends Error {}

/** 找到或新建账号下的私有备份 */
export async function openBackup(api: GitHubApi, owner: string, name = REPO_NAME): Promise<{ remote: GitHubRemote; created: boolean }> {
  type Repo = { default_branch: string; private: boolean };
  let repo = await api.json<Repo>("GET", `/repos/${owner}/${name}`, undefined, [404]);
  let created = false;
  if (!repo) {
    repo = await api.json<Repo>("POST", "/user/repos", {
      name,
      private: true,
      description: "我的笔记备份 · 由 Obsidian 插件「笔记备份」自动维护",
      has_issues: false,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    });
    created = true;
  }
  if (!repo) throw new Error("建不了备份");
  /* 笔记绝不放进公开仓库 */
  if (!repo.private) throw new PublicRepoError(`你账号里的 ${name} 是公开的。为了不泄露笔记，先在 GitHub 把它改成私有，再回来连`);
  const remote = new GitHubRemote(api, owner, name, repo.default_branch || "main");
  if (!(await remote.head())) {
    await remote.init();
    /* 刚建的仓库，GitHub 那边可能要一两秒才能读到 */
    for (let i = 0; i < 5 && !(await remote.head()); i++) await new Promise((r) => setTimeout(r, 800));
  }
  return { remote, created };
}
