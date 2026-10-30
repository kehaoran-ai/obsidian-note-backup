/**
 * [INPUT]: core 引擎与记录，github 的登录与云端，obsidian 层的笔记库与归属判定，ui 的四屏
 * [OUTPUT]: NoteBackupPlugin 插件本体：存取状态、连上 GitHub、自动备份与取回的调度、状态汇总给界面
 * [POS]: 项目入口与总调度。用户只做一步(登录 GitHub)，其余全自动都从这里发起
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Notice, Platform, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { Engine, type Progress } from "./core/engine";
import { cleanHost } from "./core/device";
import { makeIgnore } from "./core/ignore";
import { SyncLog } from "./core/log";
import { emptyState, type Clash, type SyncState, type Who } from "./core/types";
import { AuthError, GitHubApi, NetError } from "./github/api";
import { GitHubRemote } from "./github/remote";
import { http } from "./obsidian/http";
import { VaultStore } from "./obsidian/vault-store";
import { WhoTracker } from "./obsidian/who";
import { registerIcons } from "./ui/icons";
import { HISTORY_VIEW, HistoryView } from "./ui/history-view";
import { LOG_VIEW, LogView } from "./ui/log-view";
import { LoginModal } from "./ui/login";
import { MERGE_VIEW, MergeView } from "./ui/merge-view";
import { SettingsTab } from "./ui/settings";
import { StatusUI } from "./ui/status";

interface Settings {
  device: string;
  /** 用户点了暂停：不自动备份，直到点「继续备份」 */
  paused?: boolean;
  account: { login: string; owner: string; repo: string; branch: string } | null;
}

/** 界面上的状态：四种(好了、在跑、两边都改了、没网)，外加还没开启和出错 */
export type Status =
  | { kind: "setup" }
  | { kind: "ok"; at: number; files: string[] }
  | { kind: "run"; files: string[]; phase: "up" | "down"; done: number; total: number }
  | { kind: "warn"; clashes: Clash[] }
  | { kind: "off"; pending: string[] }
  | { kind: "paused"; pending: string[] }
  | { kind: "error"; message: string; relogin: boolean };

const TOKEN_KEY = "note-backup-github-token";
/** 改完停这么久没再改，就备份 */
const AFTER_EDIT = 10_000;
/** 隔这么久看一眼云端有没有别的设备的改动 */
const POLL = 60_000;

function hostName(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("os").hostname();
  } catch {
    return "";
  }
}

function defaultDevice(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return Platform.isTablet ? "安卓平板" : "安卓手机";
  return cleanHost(hostName());
}

export default class NoteBackupPlugin extends Plugin {
  settings: Settings = { device: "", account: null };
  state: SyncState = emptyState();
  log = new SyncLog();
  remote: GitHubRemote | null = null;
  engine: Engine | null = null;
  status: Status = { kind: "setup" };
  private statusUI!: StatusUI;
  private who!: WhoTracker;
  private ownWrites = new Map<string, number>();
  private timer: number | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<() => void>();
  private problem: Status | null = null;

  async onload() {
    registerIcons();
    await this.loadAll();

    this.registerView(LOG_VIEW, (leaf) => new LogView(leaf, this));
    this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this));
    this.registerView(MERGE_VIEW, (leaf) => new MergeView(leaf, this));

    this.statusUI = new StatusUI(this);
    this.statusUI.mount();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addRibbonIcon("nb-cloud", "笔记备份", () => (this.connected ? this.openLog() : this.openLogin()));
    this.addCommands();

    this.who = new WhoTracker(this, Platform.isMobile, (p) => this.isOwnWrite(p), (p, who) => this.markWho(p, who));
    this.who.register();
    /* 任何改动都让这篇的指纹缓存作废：Obsidian 的修改时间可能慢一拍，同样大小的改动会被当成没变 */
    const forget = (path: string) => delete this.state.hashes[path];
    this.registerEvent(this.app.vault.on("modify", (f) => forget(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => forget(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => (forget(f.path), forget(old))));
    const changed = () => this.connected && this.syncSoon(AFTER_EDIT);
    this.registerEvent(this.app.vault.on("modify", (f) => !this.isOwnWrite(f.path) && changed()));
    this.registerEvent(this.app.vault.on("create", (f) => !this.isOwnWrite(f.path) && changed()));
    this.registerEvent(this.app.vault.on("delete", (f) => !this.isOwnWrite(f.path) && changed()));
    this.registerEvent(this.app.vault.on("rename", () => changed()));

    this.registerInterval(window.setInterval(() => this.connected && this.syncSoon(0), POLL));
    this.registerInterval(window.setInterval(() => this.emit(), 30_000));
    this.registerDomEvent(window, "online", () => this.connected && this.syncSoon(0));
    this.registerDomEvent(window, "offline", () => this.connected && this.syncNow());
    this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.connected && this.syncSoon(500));

    this.app.workspace.onLayoutReady(() => {
      this.refreshStatus();
      if (this.connected) this.syncSoon(1500);
    });
  }

  onunload() {
    if (this.timer) window.clearTimeout(this.timer);
    /* 插件被关或重载：正在跑的那一轮停在两次请求之间，别和新加载的插件抢着写 */
    this.stopper?.abort();
  }

  /* ---------- 存取 ---------- */

  private get stateFile() {
    return `${this.manifest.dir}/state.json`;
  }
  private get logFile() {
    return `${this.manifest.dir}/log.json`;
  }

  private async loadAll() {
    this.settings = { device: "", account: null, ...((await this.loadData()) ?? {}) };
    /* 旧版本按原始电脑名存的(没改过)，换成干净的名字 */
    const raw = hostName().replace(/\.local$/, "").replace(/[-_]+/g, " ").trim();
    if (!this.settings.device || (raw && this.settings.device === raw)) this.settings.device = defaultDevice();
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(this.stateFile)) this.state = { ...emptyState(), ...JSON.parse(await adapter.read(this.stateFile)) };
      if (await adapter.exists(this.logFile)) this.log.load(JSON.parse(await adapter.read(this.logFile)));
    } catch (e) {
      console.error("笔记备份：读不了本地记录，从头对一遍", e);
      this.state = emptyState();
    }
    this.attach();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.emit();
  }

  async saveState() {
    const adapter = this.app.vault.adapter;
    await adapter.write(this.stateFile, JSON.stringify(this.state));
    await adapter.write(this.logFile, JSON.stringify(this.log.dump()));
  }

  /* 登录凭证不放进笔记库的文件里：优先系统钥匙串，其次本机存储 */
  getToken(): string | null {
    const ss = (this.app as unknown as { secretStorage?: { getSecret(id: string): string | null } }).secretStorage;
    try {
      const t = ss?.getSecret(TOKEN_KEY);
      if (t) return t;
    } catch {
      /* 旧版 Obsidian 没有 */
    }
    return this.app.loadLocalStorage(TOKEN_KEY) ?? null;
  }

  private setToken(token: string | null) {
    const ss = (this.app as unknown as { secretStorage?: { setSecret(id: string, v: string): void } }).secretStorage;
    try {
      if (ss) {
        ss.setSecret(TOKEN_KEY, token ?? "");
        this.app.saveLocalStorage(TOKEN_KEY, null);
        return;
      }
    } catch {
      /* 落到本机存储 */
    }
    this.app.saveLocalStorage(TOKEN_KEY, token);
  }

  /* ---------- 连上 / 退出 ---------- */

  get connected() {
    return !!this.engine;
  }

  api(token = this.getToken()): GitHubApi {
    return new GitHubApi(http, token ?? "");
  }

  private attach() {
    const a = this.settings.account;
    const token = this.getToken();
    if (!a || !token) {
      this.remote = null;
      this.engine = null;
      return;
    }
    this.remote = new GitHubRemote(this.api(token), a.owner, a.repo, a.branch);
    const local = new VaultStore(this.app, (p) => this.markOwnWrite(p));
    this.engine = new Engine(
      {
        local,
        remote: this.remote,
        log: this.log,
        device: () => this.settings.device,
        defaultWho: Platform.isMobile ? "me" : "ai",
        ignore: (path) => this.ignore(path),
        /* 每传完一段就存进度：中途暂停或断网，下次从这里接着 */
        checkpoint: () => this.saveState(),
        /* 同一个笔记库同一时间只跑一轮，重新登录换了引擎、插件重载也一样 */
        lock: this.app.vault.getName(),
      },
      this.state,
    );
  }

  /** 登录成功后调用：记住账号，换一套新的同步进度 */
  async connect(token: string, login: string, remote: GitHubRemote) {
    this.setToken(token);
    const same = this.settings.account?.owner === remote.owner && this.settings.account?.repo === remote.repo;
    this.settings.account = { login, owner: remote.owner, repo: remote.repo, branch: remote.branch };
    if (!same) {
      /* 换了账号或备份：从头对一遍，两边合在一起，不删任何一篇 */
      this.state = emptyState();
      this.log.load(null);
    }
    await this.saveSettings();
    this.attach();
    await this.saveState();
    this.problem = null;
    this.refreshStatus();
  }

  async disconnect() {
    this.setToken(null);
    this.settings.account = null;
    this.state = emptyState();
    this.log.load(null);
    await this.saveSettings();
    await this.saveState();
    this.attach();
    this.problem = null;
    this.refreshStatus();
  }

  /* ---------- 已有的备份 ---------- */

  /** 笔记库里 .git 记着的仓库地址(用过 Obsidian Git 之类的才有)；手机上一般没有 */
  async readGitConfig(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(".git/config")) return await adapter.read(".git/config");
    } catch {
      /* .git 是文件(子模块、工作树)或读不了：当作没有 */
    }
    return null;
  }

  private get plugins() {
    return (this.app as unknown as { plugins: { enabledPlugins: Set<string>; disablePluginAndSave(id: string): Promise<void> } }).plugins;
  }

  obsidianGitOn(): boolean {
    return this.plugins.enabledPlugins.has("obsidian-git");
  }

  /** 接上已有备份后只留一个写入方 */
  async turnOffObsidianGit() {
    if (this.obsidianGitOn()) await this.plugins.disablePluginAndSave("obsidian-git");
  }

  /* ---------- 我 / AI ---------- */

  markOwnWrite(path: string) {
    this.ownWrites.set(path, Date.now() + 3000);
    this.who?.hush(path);
  }

  isOwnWrite(path: string) {
    const t = this.ownWrites.get(path);
    if (!t) return false;
    if (t < Date.now()) {
      this.ownWrites.delete(path);
      return false;
    }
    return true;
  }

  markWho(path: string, who: Who) {
    if (!this.connected) return;
    this.state.who[path] = who;
  }

  /** 插件里用户点出来的改动(恢复版本、合并)：算我，马上备份 */
  async writeAsMe(file: TFile, text: string) {
    this.markOwnWrite(file.path);
    delete this.state.hashes[file.path];
    await this.app.vault.modify(file, text);
    this.state.who[file.path] = "me";
    await this.saveState();
  }

  /* ---------- 同步调度 ---------- */

  syncSoon(delay: number) {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delay);
  }

  /** 一次只跑一轮；跑的时候又来了请求，跑完再补一轮 */
  syncNow(onProgress?: (p: Progress) => void): Promise<void> {
    if (!this.engine) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce(onProgress);
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** 笔记库根目录 .gitignore 里的规则；每轮同步前重读，改了马上生效 */
  ignore: (path: string) => boolean = makeIgnore("");
  private async loadIgnore() {
    const adapter = this.app.vault.adapter;
    let text = "";
    try {
      if (await adapter.exists(".gitignore")) text = await adapter.read(".gitignore");
    } catch {
      /* 读不到就只用内置规则(密钥文件夹永远不上传) */
    }
    this.ignore = makeIgnore(text);
  }

  private stopper: AbortController | null = null;
  private pausedPending: string[] = [];

  /** 暂停：正在传的停在两次请求之间，已经传完的段都留着 */
  async pause() {
    this.settings.paused = true;
    await this.saveSettings();
    this.stopper?.abort();
    this.run = null;
    await this.running?.catch(() => undefined);
    this.pausedPending = (await this.engine?.pending()) ?? [];
    this.refreshStatus();
  }

  async resume() {
    this.settings.paused = false;
    await this.saveSettings();
    this.refreshStatus();
    await this.syncNow();
  }

  private async runOnce(onProgress?: (p: Progress) => void) {
    const engine = this.engine;
    if (!engine) return;
    if (this.settings.paused) {
      this.pausedPending = await engine.pending();
      this.refreshStatus();
      return;
    }
    await this.loadIgnore();
    if (!navigator.onLine) {
      this.problem = { kind: "off", pending: await engine.pending() };
      this.refreshStatus();
      return;
    }
    const pending = await engine.pending();
    if (pending.length) this.setRun({ kind: "run", files: pending, phase: "up", done: 0, total: pending.length });
    try {
      const stopper = new AbortController();
      this.stopper = stopper;
      const r = await engine.sync((p) => {
        onProgress?.(p);
        if (p.phase === "up" && p.total) this.setRun({ kind: "run", files: pending, phase: "up", done: p.done, total: p.total });
        if (p.phase === "down" && p.total) this.setRun({ kind: "run", files: [], phase: "down", done: p.done, total: p.total });
      }, stopper.signal);
      this.stopper = null;
      this.problem = null;
      await this.saveState();
      if (r.clashes.length) new Notice(`${r.clashes.length} 篇两边都改了，先用了较新的版本。点状态栏的黄点处理`);
      if (r.skipped.length) console.warn("笔记备份：太大没备份", r.skipped);
      if (r.stale) console.warn("笔记备份：读到的云端还是推之前的旧样子，这一轮不写，下一轮再对");
      if (r.deferred.length) console.warn("笔记备份：写之前这几篇刚被别的程序改过，没盖掉，下一轮再合", r.deferred);
    } catch (e) {
      console.error("笔记备份", e);
      if (e instanceof NetError) this.problem = { kind: "off", pending: await engine.pending() };
      else if (e instanceof AuthError) this.problem = { kind: "error", message: "登录失效了，可能在 GitHub 上取消了授权。重新登录一下就好。", relogin: true };
      else this.problem = { kind: "error", message: String((e as Error)?.message ?? e), relogin: false };
      await this.saveState();
    }
    this.run = null;
    this.refreshStatus();
  }

  private run: Status | null = null;
  private runPainted = 0;
  /** 进度最多每 200 毫秒刷一次界面 */
  private setRun(s: Status) {
    this.run = s;
    const last = s.kind === "run" && s.done >= s.total;
    if (!last && Date.now() - this.runPainted < 200) return;
    this.runPainted = Date.now();
    this.refreshStatus();
  }

  /** 优先级：暂停 > 在跑 > 两边都改了 > 没网 > 出错 > 好了 */
  refreshStatus() {
    if (!this.connected) this.status = { kind: "setup" };
    else if (this.settings.paused) this.status = { kind: "paused", pending: this.pausedPending };
    else if (this.run) this.status = this.run;
    else if (this.state.clashes.length) this.status = { kind: "warn", clashes: this.state.clashes };
    else if (this.problem) this.status = this.problem;
    else this.status = { kind: "ok", at: this.state.last?.at ?? 0, files: this.state.last?.files ?? [] };
    this.emit();
  }

  /** 界面订阅状态和记录的变化 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /* ---------- 两边都改了 ---------- */

  async resolveClash(path: string) {
    this.state.clashes = this.state.clashes.filter((c) => c.path !== path);
    await this.saveState();
    this.refreshStatus();
  }

  /* ---------- 打开界面 ---------- */

  openLogin() {
    new LoginModal(this.app, this).open();
  }

  async openLog() {
    const ws = this.app.workspace;
    let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(LOG_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = Platform.isMobile ? ws.getLeaf("tab") : ws.getRightLeaf(false);
      await leaf?.setViewState({ type: LOG_VIEW, active: true });
    }
    if (leaf) await ws.revealLeaf(leaf);
  }

  async openHistory(path: string, ver = 0) {
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(HISTORY_VIEW)[0] ?? ws.getLeaf("tab");
    await leaf.setViewState({ type: HISTORY_VIEW, active: true, state: { path, ver } });
    await ws.revealLeaf(leaf);
  }

  async openMerge(path?: string) {
    const target = path ?? this.state.clashes[0]?.path;
    if (!target) return new Notice("没有两边都改了的笔记");
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(MERGE_VIEW)[0] ?? ws.getLeaf("tab");
    await leaf.setViewState({ type: MERGE_VIEW, active: true, state: { path: target } });
    await ws.revealLeaf(leaf);
  }

  private addCommands() {
    this.addCommand({ id: "backup-now", name: "立即备份", callback: () => (this.connected ? this.syncNow() : this.openLogin()) });
    this.addCommand({ id: "open-log", name: "打开同步记录", callback: () => this.openLog() });
    this.addCommand({
      id: "file-history",
      name: "看这篇的历史版本",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !this.connected) return false;
        if (!checking) void this.openHistory(f.path);
        return true;
      },
    });
    this.addCommand({
      id: "open-merge",
      name: "处理两边都改了的笔记",
      checkCallback: (checking) => {
        if (!this.state.clashes.length) return false;
        if (!checking) void this.openMerge();
        return true;
      },
    });
    this.addCommand({ id: "login", name: "登录 GitHub", callback: () => this.openLogin() });
  }
}
