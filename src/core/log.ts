/**
 * [INPUT]: types 的 RemoteStore / LogCommit
 * [OUTPUT]: encodeMessage / decodeMessage 备份说明的读写；SyncLog 同步记录(从云端增量拉取、按篇查历史版本、查某篇最后修改时间)
 * [POS]: core 的记录层。每次备份把「谁、哪台设备、每篇改了什么、修改时间」写进备份说明，任何设备都能读出同一份记录
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { LogCommit, LogFile, RemoteCommit, RemoteStore, Who } from "./types";

const TAG = "note-backup:";
const MAX_COMMITS = 3000;

export function encodeMessage(who: Who, dev: string, files: LogFile[]): string {
  const title = `${who === "me" ? "我" : "AI"} · ${dev} · ${files.length} 篇`;
  const body = files.map((f) => `- ${f.p}：${f.s}`).join("\n");
  return `${title}\n\n${body}\n\n${TAG}${JSON.stringify({ v: 1, who, dev, f: files })}`;
}

export function decodeMessage(c: RemoteCommit): LogCommit | null {
  const i = c.message.lastIndexOf(TAG);
  if (i !== -1) {
    try {
      const m = JSON.parse(c.message.slice(i + TAG.length).trim());
      if (m && m.v === 1 && Array.isArray(m.f)) return { sha: c.sha, at: c.time, who: m.who === "me" ? "me" : "ai", dev: String(m.dev ?? ""), files: m.f };
    } catch {
      /* 不是本插件写的，按别的软件改的处理 */
    }
  }
  if (!c.files) return null;
  /* 别的软件(命令行、别的插件)做的备份：算编辑器外改的，也就是 AI */
  const files = c.files
    .filter((f) => !f.path.split("/").some((seg) => seg.startsWith(".")))
    .map((f) => ({ p: f.path, s: f.status === "added" ? "新建" : f.status === "removed" ? "删除" : "改了", t: c.time, h: f.sha }));
  return files.length ? { sha: c.sha, at: c.time, who: "ai", dev: "别的软件", files } : null;
}

export class SyncLog {
  commits: LogCommit[] = [];
  /** 已经看过的提交(包括没有改动的初始化提交) */
  seen = new Set<string>();

  load(data: { commits?: LogCommit[]; seen?: string[] } | null) {
    this.commits = data?.commits ?? [];
    this.seen = new Set(data?.seen ?? this.commits.map((c) => c.sha));
  }

  dump() {
    return { commits: this.commits, seen: [...this.seen].slice(-MAX_COMMITS * 2) };
  }

  /** 本设备刚备份的，直接记上，不用再从云端读 */
  add(c: LogCommit) {
    if (this.seen.has(c.sha)) return;
    this.seen.add(c.sha);
    this.commits.unshift(c);
    this.trim();
  }

  /** 把云端比本地新的备份读进来 */
  async pull(remote: RemoteStore, head: string): Promise<number> {
    if (this.seen.has(head)) return 0;
    const fresh = await remote.history(head, this.seen, 10);
    let n = 0;
    for (const c of fresh) {
      this.seen.add(c.sha);
      const lc = decodeMessage(c);
      if (lc) {
        this.commits.push(lc);
        n++;
      }
    }
    this.commits.sort((x, y) => y.at - x.at);
    this.trim();
    return n;
  }

  private trim() {
    if (this.commits.length > MAX_COMMITS) this.commits.length = MAX_COMMITS;
  }

  /** 某篇的每一版，新到旧 */
  versions(path: string): (LogFile & { who: Who; dev: string; commit: string })[] {
    const out: (LogFile & { who: Who; dev: string; commit: string })[] = [];
    for (const c of this.commits) for (const f of c.files) if (f.p === path) out.push({ ...f, who: c.who, dev: c.dev, commit: c.sha });
    return out.sort((x, y) => y.t - x.t);
  }

  /** 内容指纹为 sha 的那一版是什么时候、在哪台设备、谁改的 */
  findVersion(path: string, sha: string) {
    return this.versions(path).find((v) => v.h === sha) ?? null;
  }
}
