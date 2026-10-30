/**
 * [INPUT]: bytes 的指纹与文本判定，types 的 LocalStore / RemoteStore / SyncState，merge 的三方合并，log 的同步记录，summary 的改动文案
 * [OUTPUT]: Engine(sync 一次完整的备份 + 取回，pending 还没备份的篇)；EngineDeps、SyncResult、Progress 形状；Stopped 暂停信号；MAX_SIZE 单篇上限；keepPath 路径过滤
 * [POS]: core 的心脏。只认「本地、云端、上次两边都认可的版本」三份指纹，不依赖 Obsidian 和 GitHub 的具体实现，可单测。
 *        外部进程(AI 会话、git)随时在写：同一时间只跑一轮；读到旧的分支头整轮不写；写回前直读磁盘核对，变了就留到下一轮
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { asText, gitBlobSha, utf8 } from "./bytes";
import { encodeMessage, SyncLog } from "./log";
import { merge3, pseudoBase } from "./merge";
import { summarize } from "./summary";
import type { Clash, FileChange, LocalStore, LogCommit, LogFile, RemoteStore, Skip, SyncState, Who } from "./types";

/** GitHub 单个文件超过 50MB 会警告，超过 100MB 拒收；大文件先跳过 */
export const MAX_SIZE = 50 * 1024 * 1024;

/** 以点开头的文件夹(.obsidian、.trash、.git)不备份 */
export const keepPath = (p: string) => !p.split("/").some((seg) => seg.startsWith("."));

/** 一次改动超过这么多篇(比如 AI 批量改)，不逐篇取旧版写摘要，省请求 */
const DETAIL_LIMIT = 50;
/** 扫描时读到的内容留着给上传用，最多留这么多字节 */
const KEEP_BYTES = 64 * 1024 * 1024;
/** 一次传太多篇，中途断了就全白传；分段提交，每段生效后存进度 */
const CHUNK = 300;
/** 同时读几篇：读文件是等磁盘，并发能快好几倍 */
const PARALLEL = 8;
/** 没写回的记录最多留几条 */
const MAX_SKIPS = 100;

/*
 * 同一时间只跑一轮。两轮叠在一起时，后一轮拿着前一轮改到一半的进度比对，会把刚备份的篇当成云端删了。
 * 队挂在 globalThis 上、按笔记库排：插件重载后旧引擎还在跑的那一轮，和新引擎也排进同一条队。
 */
const GATES_KEY = "__noteBackupGates";
function gates(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<string, Map<string, Promise<unknown>>>;
  return (g[GATES_KEY] ??= new Map());
}
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (gates().get(key) ?? Promise.resolve()).then(fn, fn);
  /* 出错照样抛给调用方(返回的是 run)；排队的下一轮只等它结束，不管成败 */
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  gates().set(key, settled);
  return run;
}
let engines = 0;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export interface Progress {
  phase: "scan" | "up" | "down";
  done: number;
  total: number;
}

/** 用户点了暂停：已经生效的段留着，剩下的下次接着传 */
export class Stopped extends Error {
  constructor() {
    super("暂停了");
  }
}

export interface SyncResult {
  /** 这一轮被暂停打断 */
  stopped?: boolean;
  /** 读到的分支头比上次自己推上去的还旧(GitHub 接口缓存)，这一轮什么都没做 */
  stale?: boolean;
  /** 写之前外部进程刚改过、留到下一轮再合的篇 */
  deferred: string[];
  up: string[];
  down: string[];
  removedLocal: string[];
  removedRemote: string[];
  clashes: Clash[];
  skipped: string[];
  commits: LogCommit[];
}

export interface EngineDeps {
  local: LocalStore;
  remote: RemoteStore;
  log: SyncLog;
  device: () => string;
  /** 没有记录到「谁改的」时算谁：电脑上算 AI(编辑器外改的)，手机上都算我 */
  defaultWho: Who;
  /** 按笔记库 .gitignore 跳过的篇(密钥文件夹永远跳过)，见 core/ignore */
  ignore?: (path: string) => boolean;
  /** 每传完一段就调一次，让外面把进度存盘；中途停了、断了，下次从这里接着传 */
  checkpoint?: () => Promise<void>;
  /** 一段最多几篇，测试里调小 */
  chunk?: number;
  /** 排队用的笔记库名：同名的同一时间只跑一轮。不给就每个引擎各排各的(测试里一个进程模拟几台设备) */
  lock?: string;
  now?: () => number;
}

interface Scanned {
  h: string;
  m: number;
  s: number;
}

/** 要备份上去的一篇 */
interface Planned extends FileChange {
  who: Who;
  t: number;
  s: string;
  k?: "won" | "lost";
}

/** 备份成功后要写回本地的一篇 */
interface Writeback {
  path: string;
  /** 直接给内容，或者给云端指纹去取 */
  data?: Uint8Array;
  sha: string | null;
  /** 扫描时本地的样子；写之前又变了就不写，下次再合 */
  expect: Scanned | null;
}

export class Engine {
  private now: () => number;

  private lock: string;

  constructor(private deps: EngineDeps, public state: SyncState) {
    this.now = deps.now ?? Date.now;
    this.lock = deps.lock ?? `engine-${++engines}`;
  }

  /** 本地变了、还没备份的篇 */
  pending(): Promise<string[]> {
    return exclusive(this.lock, () => this.pendingNow());
  }

  private async pendingNow(): Promise<string[]> {
    const { files } = await this.scan();
    const st = this.state;
    const out = new Set<string>();
    for (const [p, f] of Object.entries(files)) if (st.base[p] !== f.h) out.add(p);
    for (const p of Object.keys(st.base)) if (!files[p] && this.keep(p)) out.add(p);
    return [...out];
  }

  sync(onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<SyncResult> {
    return exclusive(this.lock, () => this.syncNow(onProgress, signal));
  }

  private async syncNow(onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<SyncResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.once(onProgress, signal);
      if (r) return r;
    }
    throw new Error("别的设备一直在备份，稍后自动再试");
  }

  /** 这篇参不参与同步：点开头的文件夹和 .gitignore 里的都不参与 */
  private keep(p: string): boolean {
    return keepPath(p) && !this.deps.ignore?.(p);
  }

  private skip(path: string | null, why: Skip["why"]) {
    const st = this.state;
    st.skips = [...(st.skips ?? []), { path, at: this.now(), why }].slice(-MAX_SKIPS);
  }

  private whoOf(p: string): Who {
    return this.state.who[p] ?? this.deps.defaultWho;
  }

  /** 扫描时刚读过的内容，上传时直接用，不再读一遍 */
  private fresh = new Map<string, Uint8Array>();

  private async scan(onProgress?: (p: Progress) => void): Promise<{ files: Record<string, Scanned>; skipped: string[] }> {
    const { local } = this.deps;
    const st = this.state;
    const list = (await local.list()).filter((e) => this.keep(e.path));
    const files: Record<string, Scanned> = {};
    const skipped: string[] = [];
    const hashes: SyncState["hashes"] = {};
    const todo: typeof list = [];
    this.fresh.clear();
    let kept = 0;
    for (const e of list) {
      if (e.size > MAX_SIZE) {
        skipped.push(e.path);
        continue;
      }
      const c = st.hashes[e.path];
      if (c && c.m === e.mtime && c.s === e.size) {
        hashes[e.path] = c;
        files[e.path] = { h: c.h, m: e.mtime, s: e.size };
      } else todo.push(e);
    }
    let done = 0;
    await pool(todo, PARALLEL, async (e) => {
      const data = await local.read(e.path);
      const h = await gitBlobSha(data);
      hashes[e.path] = { m: e.mtime, s: e.size, h };
      files[e.path] = { h, m: e.mtime, s: e.size };
      if (kept + data.byteLength <= KEEP_BYTES) {
        this.fresh.set(e.path, data);
        kept += data.byteLength;
      }
      if (++done % 200 === 0) onProgress?.({ phase: "scan", done, total: todo.length });
    });
    st.hashes = hashes;
    return { files, skipped };
  }

  /** 一轮同步。别的设备抢先备份了返回 null，外层重来 */
  private async once(onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<SyncResult | null> {
    const { local, remote, log } = this.deps;
    const st = this.state;
    const dev = this.deps.device();

    const head = await remote.head();
    if (!head) throw new Error("云端备份还没建好");
    /*
     * 读到的分支头比上次自己推上去的还旧：GitHub 的读接口缓存 60 秒，刚推完紧跟的一轮会读到推之前的值。
     * 拿旧的云端比，刚备份的篇会被当成「云端删了 / 云端改回去了」，写回本地就是把新文件丢进回收站、把新版改回旧版。
     * 这一轮什么都不做，等缓存过期的下一轮。没见过的提交是别的设备新推的，不用问 GitHub。
     */
    if (st.head && head !== st.head && log.seen.has(head) && (await remote.isBehind(head, st.head))) {
      this.skip(null, "stale");
      return { stale: true, up: [], down: [], removedLocal: [], removedRemote: [], clashes: [], skipped: [], deferred: [], commits: [] };
    }
    if (head !== st.head) await log.pull(remote, head);
    let tree: string;
    let remoteFiles: Record<string, string>;
    if (head === st.head && st.tree) {
      tree = st.tree;
      remoteFiles = { ...st.remote };
    } else {
      const t = await remote.tree(head);
      tree = t.tree;
      remoteFiles = Object.fromEntries(Object.entries(t.files).filter(([p]) => keepPath(p)));
    }
    /* 跳过的篇三份一起去掉：规则后加的，已经备份过的也不会被当成删除 */
    for (const p of Object.keys(remoteFiles)) if (!this.keep(p)) delete remoteFiles[p];

    const { files: mine, skipped } = await this.scan(onProgress);
    const skip = new Set(skipped);
    const textOf = async (sha: string | undefined) => (sha ? asText(await remote.readBlob(sha)) : null);

    const lost: Planned[] = [];
    const changes: Planned[] = [];
    const writes: Writeback[] = [];
    const clashes: Clash[] = [];
    const nextBase: Record<string, string> = { ...st.base };

    const ups: { p: string; l?: string; b?: string; r?: string }[] = [];
    const paths = new Set([...Object.keys(st.base), ...Object.keys(mine), ...Object.keys(remoteFiles)]);
    for (const p of [...paths].sort()) {
      if (skip.has(p) || !this.keep(p)) continue;
      const b = st.base[p];
      const l = mine[p]?.h;
      const r = remoteFiles[p];
      if (l === r) {
        if (l) nextBase[p] = l;
        else delete nextBase[p];
        continue;
      }
      /* 只有云端变了：取回(云端删了就删本地) */
      if (l === b || (l === undefined && r !== b)) {
        writes.push({ path: p, sha: r ?? null, expect: mine[p] ?? null });
        continue;
      }
      /* 只有本地变了，或者云端删了但本地改了：备份上去，一篇都不丢 */
      if (r === b || r === undefined) {
        ups.push({ p, l, b, r });
        continue;
      }
      /* 两边都改了，改得不一样 */
      await this.resolve(p, b, mine[p], r, { lost, changes, writes, clashes, dev });
    }

    /* 要备份上去的篇：并发读，读到的真内容再核一次指纹(缓存按修改时间和大小命中，可能慢一拍) */
    const detail = ups.length <= DETAIL_LIMIT;
    const planned = new Map<string, Planned>();
    await pool(ups, PARALLEL, async ({ p, l, b, r }) => {
      const data = l === undefined ? null : this.fresh.get(p) ?? (await local.read(p));
      if (data) {
        const real = await gitBlobSha(data);
        if (real !== l && mine[p]) st.hashes[p] = { m: mine[p].m, s: mine[p].s, h: real };
        if (real === r) {
          nextBase[p] = real;
          return;
        }
      }
      const text = data && asText(data);
      const s = data === null ? "删除" : b && !detail ? "改了" : summarize(b ? await textOf(b) : null, text, text === null);
      planned.set(p, { path: p, data, who: this.whoOf(p), t: mine[p]?.m ?? this.now(), s });
    });
    for (const u of ups) {
      const x = planned.get(u.p);
      if (x) changes.push(x);
    }
    this.fresh.clear();

    /*
     * 备份：分段提交，每段生效(云端指过去)后就存进度。
     * 两边都改了的排最前，和被盖掉的本地版放在第一段里一起生效，不会只生效一半。
     * 要写回本地的篇(合并结果)，上次认可的版本等写回成功再更新，中途停了下次会再合一遍。
     */
    const pendingWrite = new Set(writes.map((w) => w.path));
    changes.sort((a, b) => Number(!!b.k) - Number(!!a.k));
    const size = this.deps.chunk ?? CHUNK;
    const segments: Planned[][] = [];
    for (let i = 0; i < changes.length; i += size) segments.push(changes.slice(i, i + size));
    if (!segments.length && lost.length) segments.push([]);
    let parent = head;
    let parentTree = tree;
    const made: LogCommit[] = [];
    const total = lost.length + changes.length;
    let done = 0;
    let stopped = false;
    /* 只生效了前几段(停了，或别的设备在段间抢先) */
    let cut = false;
    const commitGroup = async (group: Planned[], who: Who, out: LogCommit[]) => {
      if (!group.length) return;
      const files: LogFile[] = [];
      for (const g of group) files.push({ p: g.path, s: g.s, t: g.t, h: g.data ? await gitBlobSha(g.data) : null, ...(g.k ? { k: g.k } : {}) });
      const res = await remote.writeCommit(
        parent,
        parentTree,
        group,
        encodeMessage(who, dev, files),
        (n) => onProgress?.({ phase: "up", done: done + n, total }),
        signal,
      );
      done += group.length;
      parent = res.commit;
      parentTree = res.tree;
      out.push({ sha: res.commit, at: this.now(), who, dev, files });
    };
    for (let i = 0; i < segments.length; i++) {
      if (signal?.aborted) {
        stopped = true;
        cut = true;
        break;
      }
      const seg = segments[i];
      const from = parent;
      const fromTree = parentTree;
      const segMade: LogCommit[] = [];
      try {
        for (const g of i === 0 ? [lost, seg] : [seg]) {
          await commitGroup(g.filter((x) => x.who === "me"), "me", segMade);
          await commitGroup(g.filter((x) => x.who === "ai"), "ai", segMade);
        }
      } catch (e) {
        if (!(e instanceof Stopped)) throw e;
        /* 这一段没生效，回到段首 */
        parent = from;
        parentTree = fromTree;
        stopped = true;
        cut = true;
        break;
      }
      if (!(await remote.moveHead(parent, from))) {
        if (i === 0) return null;
        /* 别的设备在段与段之间抢先了：已生效的段存好，下一轮接着 */
        parent = from;
        parentTree = fromTree;
        cut = true;
        break;
      }
      for (const c of seg) {
        if (c.data) remoteFiles[c.path] = await gitBlobSha(c.data);
        else delete remoteFiles[c.path];
        if (!pendingWrite.has(c.path)) {
          if (remoteFiles[c.path]) nextBase[c.path] = remoteFiles[c.path];
          else delete nextBase[c.path];
        }
        delete st.who[c.path];
      }
      const segPaths = new Set(seg.map((c) => c.path));
      for (const c of clashes) if (segPaths.has(c.path)) st.clashes = [...st.clashes.filter((x) => x.path !== c.path), c];
      for (const m of segMade) {
        made.push(m);
        log.add(m);
      }
      st.head = parent;
      st.tree = parentTree;
      st.remote = { ...remoteFiles };
      st.base = { ...nextBase };
      await this.deps.checkpoint?.();
    }
    if (cut) {
      /* 停了：取回和写回留到下次 */
      const up = made.flatMap((m) => m.files.filter((f) => f.h).map((f) => f.p));
      if (made.length) st.last = { at: this.now(), files: up };
      return { stopped, up, down: [], removedLocal: [], removedRemote: [], clashes: [], skipped, deferred: [], commits: made };
    }

    /*
     * 写回本地(几篇一起写)。写之前本地又变了的不写，下次再合。
     * 修改时间和大小是 Obsidian 缓存的，外部进程刚写完时还是旧的；所以再直读磁盘算一次指纹，和扫描时对不上也不写
     */
    const removedLocal: string[] = [];
    const down: string[] = [];
    const deferred: string[] = [];
    let wrote = 0;
    await pool(writes, 4, async (w) => {
      if (signal?.aborted) return;
      onProgress?.({ phase: "down", done: wrote++, total: writes.length });
      const now = await local.stat(w.path);
      const exp = w.expect;
      const disk = await local.peek(w.path);
      const moved = now ? !exp || now.mtime !== exp.m || now.size !== exp.s : exp;
      if (moved || (disk ? await gitBlobSha(disk) : null) !== (exp?.h ?? null)) {
        deferred.push(w.path);
        this.skip(w.path, "changed");
        return;
      }
      if (w.sha === null && !w.data) {
        await local.remove(w.path);
        delete nextBase[w.path];
        delete st.hashes[w.path];
        removedLocal.push(w.path);
        return;
      }
      const data = w.data ?? (await remote.readBlob(w.sha as string));
      await local.write(w.path, data);
      /* 取回的内容指纹就是云端那个，不用再算 */
      const sha = w.sha ?? (await gitBlobSha(data));
      nextBase[w.path] = remoteFiles[w.path] ?? sha;
      const after = await local.stat(w.path);
      if (after) st.hashes[w.path] = { m: after.mtime, s: after.size, h: sha };
      down.push(w.path);
    });
    down.sort();
    removedLocal.sort();
    deferred.sort();
    if (writes.length) onProgress?.({ phase: "down", done: writes.length, total: writes.length });

    st.head = parent;
    st.tree = parentTree;
    st.remote = remoteFiles;
    st.base = nextBase;
    const up = changes.filter((c) => c.data).map((c) => c.path);
    if (made.length || writes.length || !st.last) st.last = { at: this.now(), files: up.length ? up : st.last?.files ?? [] };
    else st.last = { ...st.last, at: this.now() };
    return {
      stopped: !!signal?.aborted,
      up,
      down,
      removedLocal,
      removedRemote: changes.filter((c) => !c.data).map((c) => c.path),
      clashes,
      skipped,
      deferred,
      commits: made,
    };
  }

  /**
   * 冲突三层：
   * 1 能自动合的自动合(不同段落两边都留)；
   * 2 合不了的先用修改时间较新的那边，同步不停，记一笔「两边都改了」亮黄点；
   * 3 事后在合并页选(见 merge.mergeBlocks)。被盖掉的那版一定留在云端历史里。
   */
  private async resolve(
    p: string,
    b: string | undefined,
    mineEntry: Scanned,
    r: string,
    out: { lost: Planned[]; changes: Planned[]; writes: Writeback[]; clashes: Clash[]; dev: string },
  ) {
    const { local, remote, log } = this.deps;
    const mine = await local.read(p);
    const theirs = await remote.readBlob(r);
    const rv = log.findVersion(p, r);
    const lm = mineEntry.m;
    const rm = rv?.t ?? 0;
    const localNewer = lm >= rm;
    const who = this.whoOf(p);
    const meLabel = { dev: out.dev, t: lm, who };
    const themLabel = { dev: rv?.dev ?? "另一台设备", t: rm, who: rv?.who ?? ("ai" as Who) };
    const mt = asText(mine);
    const tt = asText(theirs);
    /* 合并用的是刚读的真内容；写回前按它核对，扫描时的指纹可能是缓存 */
    const expect = { ...mineEntry, h: await gitBlobSha(mine) };

    if (mt !== null && tt !== null) {
      const baseText = b ? asText(await remote.readBlob(b)) ?? "" : pseudoBase(mt, tt);
      const m = merge3(mt, baseText, tt, localNewer ? "mine" : "theirs");
      const merged = utf8(m.text);
      const sha = await gitBlobSha(merged);
      if (m.conflicts > 0) {
        const n = m.conflicts;
        if (!localNewer) out.lost.push({ path: p, data: mine, who, t: lm, s: `改了同 ${n} 处 · 被盖掉了`, k: "lost" });
        out.clashes.push({
          path: p,
          at: this.now(),
          binary: false,
          base: baseText,
          loser: localNewer ? tt : mt,
          loserLabel: localNewer ? themLabel : meLabel,
          winnerLabel: localNewer ? meLabel : themLabel,
          count: n,
        });
        if (sha !== r || !localNewer)
          out.changes.push({ path: p, data: merged, who, t: Math.max(lm, rm), s: localNewer ? `改了 ${n} 处 · 现在用的这版` : `用了较新的${themLabel.dev}版 · 现在用的这版`, k: "won" });
      } else if (sha !== r) {
        out.changes.push({ path: p, data: merged, who, t: Math.max(lm, rm), s: "两边的改动合在一起" });
      }
      if (sha !== expect.h) out.writes.push({ path: p, data: merged, sha, expect });
      return;
    }

    /* 附件合不了：整份用较新的 */
    if (localNewer) {
      out.changes.push({ path: p, data: mine, who, t: lm, s: "换了内容 · 现在用的这版", k: "won" });
      out.clashes.push({ path: p, at: this.now(), binary: true, base: "", loser: r, loserLabel: themLabel, winnerLabel: meLabel, count: 1 });
    } else {
      out.lost.push({ path: p, data: mine, who, t: lm, s: "换了内容 · 被盖掉了", k: "lost" });
      out.changes.push({ path: p, data: theirs, who, t: rm, s: `用了较新的${themLabel.dev}版 · 现在用的这版`, k: "won" });
      out.clashes.push({ path: p, at: this.now(), binary: true, base: "", loser: expect.h, loserLabel: meLabel, winnerLabel: themLabel, count: 1 });
      out.writes.push({ path: p, data: theirs, sha: r, expect });
    }
  }
}
