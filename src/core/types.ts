/**
 * [INPUT]: 无
 * [OUTPUT]: 同步引擎的全部数据形状：Who、LocalEntry、LocalStore、FileChange、RemoteCommit、RemoteStore、LogFile、LogCommit、Clash、SyncState、Skip；emptyState 空的同步进度
 * [POS]: core 的契约层，engine / log / github / obsidian 四方都只依赖这里的形状
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 谁改的：编辑器里改的算「我」，编辑器外改的算「AI」 */
export type Who = "me" | "ai";

/** 本地一篇的元信息 */
export interface LocalEntry {
  path: string;
  mtime: number;
  size: number;
}

/** 本地笔记库：电脑和手机都只经过 Obsidian 的 vault，不碰 Node */
export interface LocalStore {
  list(): Promise<LocalEntry[]>;
  stat(path: string): Promise<LocalEntry | null>;
  read(path: string): Promise<Uint8Array>;
  /** 绕开 Obsidian 的文件信息缓存直读磁盘；不存在返回 null。写回前用它核对外部进程有没有刚改过 */
  peek(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/** 一次改动：data 为 null 表示删掉 */
export interface FileChange {
  path: string;
  data: Uint8Array | null;
}

/** 云端的一次备份(一个提交) */
export interface RemoteCommit {
  sha: string;
  time: number;
  message: string;
  /** 不是本插件写的提交，才需要单独拿改了哪些篇 */
  files?: { path: string; sha: string | null; status: string }[];
}

/** 云端：用户 GitHub 账号里的那份备份 */
export interface RemoteStore {
  head(): Promise<string | null>;
  tree(commit: string): Promise<{ tree: string; files: Record<string, string> }>;
  readBlob(sha: string): Promise<Uint8Array>;
  writeCommit(
    parent: string,
    parentTree: string,
    changes: FileChange[],
    message: string,
    onProgress?: (done: number) => void,
    /** 用户点了暂停：在两次请求之间停下，抛 engine.Stopped */
    signal?: AbortSignal,
  ): Promise<{ commit: string; tree: string }>;
  /** sha 是不是 than 的祖先：读到的分支头比上次自己推上去的还旧，说明读到了缓存 */
  isBehind(sha: string, than: string): Promise<boolean>;
  /** 只做快进；别的设备抢先备份了就返回 false */
  moveHead(to: string, from: string): Promise<boolean>;
  /** 从 head 往回取提交，遇到 known 里的就停 */
  history(head: string, known: Set<string>, maxPages: number): Promise<RemoteCommit[]>;
}

/** 同步记录里的一行：一篇在一次备份里的一次改动 */
export interface LogFile {
  /** 路径 */
  p: string;
  /** 改了什么，一句话 */
  s: string;
  /** 修改时间 */
  t: number;
  /** 这一版的内容指纹；删掉时为 null */
  h: string | null;
  /** 两边都改了时：won = 现在用的这版，lost = 被盖掉的 */
  k?: "won" | "lost";
}

/** 同步记录里的一次备份 */
export interface LogCommit {
  sha: string;
  at: number;
  who: Who;
  dev: string;
  files: LogFile[];
}

/** 两边都改了、自动合不了的一篇。黄点一直亮到它被处理掉 */
export interface Clash {
  path: string;
  at: number;
  binary: boolean;
  /** 共同的旧版(文本)。第二台设备第一次合并时没有旧版，用两边相同的行代替 */
  base: string;
  /** 被盖掉的那版：文本放全文，附件放内容指纹 */
  loser: string;
  loserLabel: { dev: string; t: number; who: Who };
  winnerLabel: { dev: string; t: number; who: Who };
  /** 合不了的处数 */
  count: number;
}

/** 本地记住的同步进度 */
export interface SyncState {
  /** 上次和云端对齐时的云端提交 */
  head: string | null;
  tree: string | null;
  /** 那次提交里每篇的内容指纹 */
  remote: Record<string, string>;
  /** 两边上次都认可的内容指纹。下载失败的篇保持旧值，下次重试 */
  base: Record<string, string>;
  /** 本地内容指纹缓存，按修改时间和大小命中 */
  hashes: Record<string, { m: number; s: number; h: string }>;
  /** 还没备份的改动是谁做的 */
  who: Record<string, Who>;
  clashes: Clash[];
  /** 没写回本地的记录：changed 是写之前外部进程刚改过这篇，stale 是读到的分支头是旧的、整轮不写。最多留 100 条 */
  skips: Skip[];
  last: { at: number; files: string[] } | null;
}

export interface Skip {
  /** stale 是整轮没写，没有篇名 */
  path: string | null;
  at: number;
  why: "changed" | "stale";
}

export const emptyState = (): SyncState => ({
  head: null,
  tree: null,
  remote: {},
  base: {},
  hashes: {},
  who: {},
  clashes: [],
  skips: [],
  last: null,
});
