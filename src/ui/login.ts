/**
 * [INPUT]: github 的设备码登录与备份查找，插件本体的 connect / syncNow
 * [OUTPUT]: LoginModal 登录四步：有没有账号 → 带着注册 → 填码 → 已连上(第一次备份 / 找到你的备份并取回 / 认出笔记库原来的备份接着用 / 原来的备份在组织里被挡时带去批准)
 * [POS]: 设计稿第 1 屏。先分人再给码：没账号的先注册，注册好才要码，码不会在注册时过期；码过期自动换新
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Modal, type App } from "obsidian";
import { GitHubApi, NetError } from "../github/api";
import { clientIdReady, requestCode, SIGNUP_URL, waitForToken, whoami, type DeviceCode } from "../github/auth";
import { APPROVE_URL, findExisting, type Existing } from "../github/existing";
import { describeBackup, openBackup, PublicRepoError } from "../github/remote";
import type NoteBackupPlugin from "../main";
import { http } from "../obsidian/http";
import { svgIcon, type IconName } from "./icons";
import { ago, button, dot, meter } from "./kit";

type Step = "pick" | "sign" | "code" | "done";

export class LoginModal extends Modal {
  private step: Step = "pick";
  private abort: AbortController | null = null;
  private code: DeviceCode | null = null;
  private codeError: string | null = null;

  constructor(app: App, private plugin: NoteBackupPlugin) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("nb-login");
    this.show("pick");
  }

  onClose() {
    this.abort?.abort();
    this.contentEl.empty();
  }

  private show(step: Step) {
    this.step = step;
    if (step !== "code") this.abort?.abort();
    const el = this.contentEl;
    el.empty();
    if (step === "pick") this.pick(el);
    if (step === "sign") this.sign(el);
    if (step === "code") this.codeStep(el);
  }

  private badge(el: HTMLElement, icon: IconName, cls = "is-ink") {
    svgIcon(el.createSpan({ cls: `nb-badge ${cls}` }), icon);
  }

  private head(el: HTMLElement, right: string) {
    const h = el.createDiv({ cls: "nb-mhead" });
    button(h, "返回", "tag-sm", () => this.show("pick"), "back");
    h.createSpan({ text: right, cls: "nb-muted" });
  }

  /* ---------- 1 有没有账号 ---------- */
  private pick(el: HTMLElement) {
    this.badge(el, "cloud");
    el.createEl("h3", { text: "把笔记备份到 GitHub" });
    el.createEl("p", { cls: "nb-sub", text: "GitHub 是免费的云端，备份放在你自己的账号里，设成私有，只有你能看。" });
    el.createDiv({ cls: "nb-step", text: "你有 GitHub 账号吗？" });
    const box = el.createDiv({ cls: "nb-choices" });
    const choice = (icon: IconName, title: string, sub: string, go: Step) => {
      const b = box.createEl("button", { cls: "nb-choice" });
      svgIcon(b.createSpan({ cls: "nb-badge" }), icon);
      const t = b.createSpan();
      t.createEl("b", { text: title });
      t.createEl("small", { text: sub });
      svgIcon(b, "chev");
      b.addEventListener("click", () => this.show(go));
    };
    choice("plus", "没有，帮我注册一个", "免费，跟着走几分钟就好", "sign");
    choice("user", "有，直接登录", "填一串码就连上", "code");
    el.createDiv({ cls: "nb-foot", text: "没听过 GitHub 也没关系。它是程序员常用的免费网站，这里只拿它当保险箱。" });
  }

  /* ---------- 2 带着注册 ---------- */
  private sign(el: HTMLElement) {
    this.head(el, "第 1 步 · 共 2 步");
    el.createEl("h3", { text: "先注册一个 GitHub 账号" });
    el.createEl("p", { cls: "nb-sub", text: "点下面的按钮，在浏览器里填完这几项，再回到这里。" });
    const ol = el.createEl("ol", { cls: "nb-todo" });
    const li = (b: string, s: string) => {
      const x = ol.createEl("li");
      x.createEl("b", { text: b });
      x.createSpan({ text: s });
    };
    li("邮箱", "用常用的，验证码会发到这里");
    li("密码、用户名", "用户名别人看得到，笔记看不到");
    li("过一个小验证", "再填邮件里的验证码");
    li("出现问卷就跳过", "浏览器停在填码页，就是注册好了");
    button(el, "打开 GitHub 注册页", "primary", () => window.open(SIGNUP_URL)).addClass("is-block");
    const w = el.createDiv({ cls: "nb-waiting" });
    w.createSpan({ cls: "nb-w", text: "注册好了？回来点这里" });
    button(w, "注册好了，下一步", "tag", () => this.show("code"));
  }

  /* ---------- 3 填码 ---------- */
  private codeStep(el: HTMLElement) {
    this.head(el, "最后一步");
    el.createEl("h3", { text: "在 GitHub 填这串码" });
    el.createEl("p", { cls: "nb-sub", text: "填完点「授权」，就连上了。你的密码只在 GitHub 上输，插件拿不到。" });
    const box = el.createDiv({ cls: "nb-code" });
    const main = el.createDiv();
    const foot = el.createDiv({ cls: "nb-foot", text: "刚注册完？浏览器已经停在填码页，把码粘进去就行。" });
    void foot;

    const paint = () => {
      box.empty();
      main.empty();
      if (this.codeError) {
        box.createEl("b", { text: "— — — —", cls: "is-dim" });
        main.createEl("p", { cls: "nb-err", text: this.codeError });
        button(main, "重新拿一串码", "primary", () => void fetchCode()).addClass("is-block");
        return;
      }
      if (!this.code) {
        box.createEl("b", { text: "…", cls: "is-dim" });
        const w = main.createDiv({ cls: "nb-waiting" });
        w.createSpan({ cls: "nb-spin" });
        w.createSpan({ cls: "nb-w", text: "正在向 GitHub 要码…" });
        return;
      }
      const code = this.code;
      box.createEl("b", { text: code.user_code });
      const copy = button(box, "复制", "tag", () => {
        void navigator.clipboard.writeText(code.user_code);
        const s = copy.querySelector("span:last-child") as HTMLElement;
        s.setText("已复制");
        window.setTimeout(() => s.setText("复制"), 1500);
      }, "copy");
      button(main, "复制并打开 GitHub", "primary", () => {
        void navigator.clipboard.writeText(code.user_code);
        window.open(code.verification_uri);
      }).addClass("is-block");
      const w = main.createDiv({ cls: "nb-waiting" });
      w.createSpan({ cls: "nb-spin" });
      w.createSpan({ cls: "nb-w", text: "等你在 GitHub 点「授权」…" });
      w.createEl("em", { text: "码过期会自动换新" });
    };

    const fetchCode = async () => {
      this.abort?.abort();
      const ac = new AbortController();
      this.abort = ac;
      this.code = null;
      this.codeError = null;
      paint();
      if (!clientIdReady()) {
        this.codeError = "插件还没配好 GitHub 登录(缺 Client ID)，现在登录不了。";
        return paint();
      }
      try {
        /* 码过期就换一串新的，接着等 */
        for (;;) {
          this.code = await requestCode(http);
          if (ac.signal.aborted) return;
          paint();
          const r = await waitForToken(http, this.code, ac.signal);
          if ("token" in r) return void this.finish(r.token);
          if ("denied" in r) {
            this.codeError = "你在 GitHub 点了取消。想连的话，重新拿一串码。";
            return paint();
          }
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        this.codeError = e instanceof NetError ? "连不上 GitHub。检查一下网络，再点下面重试。" : String((e as Error).message);
        paint();
      }
    };
    void fetchCode();
  }

  /* ---------- 4 已连上 ---------- */
  private async finish(token: string) {
    const el = this.contentEl;
    el.empty();
    this.step = "done";
    const wait = el.createDiv({ cls: "nb-waiting" });
    wait.createSpan({ cls: "nb-spin" });
    wait.createSpan({ cls: "nb-w", text: "连上了，正在找你的备份…" });
    try {
      const api = new GitHubApi(http, token);
      const login = await whoami(api);
      /* 笔记库里记着原来的备份(用过 Obsidian Git 之类的)：接着用它，不另建 */
      const existing = await findExisting(api, await this.plugin.readGitConfig());
      if (existing?.kind === "ok") return this.existing(token, login, existing);
      if (existing?.kind === "blocked") return this.blocked(token, login, existing);
      await this.createNew(token, login, api);
    } catch (e) {
      this.problem(e, () => void this.finish(token));
    }
  }

  private problem(e: unknown, retry: () => void) {
    const el = this.contentEl;
    el.empty();
    this.badge(el, "info", "is-warn");
    el.createEl("h3", { text: "还差一点" });
    el.createEl("p", {
      cls: "nb-sub",
      text: e instanceof PublicRepoError ? e.message : e instanceof NetError ? "连不上 GitHub。检查一下网络再试。" : String((e as Error).message),
    });
    button(el, "再试一次", "primary", retry).addClass("is-block");
  }

  /** 新建「我的笔记备份」，或者账号里已经有插件建的那份 */
  private async createNew(token: string, login: string, api = new GitHubApi(http, token)) {
    const remote = (await openBackup(api, login)).remote;
    const found = await describeBackup(remote);
    await this.plugin.connect(token, login, remote);
    if (found) this.found(login, found);
    else this.firstBackup(login);
  }

  /**
   * 认出了原来的备份，但它在组织里，组织还没批准「笔记备份」。
   * 一个主按钮走两步：先「去 GitHub 批准」，点过就变成「批准好了，重试」。
   */
  private blocked(token: string, login: string, ex: Extract<Existing, { kind: "blocked" }>, opened = false, again = false) {
    const el = this.contentEl;
    el.empty();
    this.badge(el, "info", "is-warn");
    el.createEl("h3", { text: "找到你原来的备份" });
    el.createEl("p", { cls: "nb-sub", text: "它在组织里，组织批准后就能接着用，不另建一份。" });
    const card = el.createDiv({ cls: "nb-found" });
    svgIcon(card.createSpan({ cls: "nb-badge" }), "cloud");
    const t = card.createDiv();
    t.createEl("b", { text: ex.full.split("/")[1] ?? ex.full });
    const sub = t.createSpan({ cls: "nb-found-sub" });
    dot(sub, "warn");
    sub.createSpan({ text: `还没批准 · 组织 ${ex.org}` });
    const open = () => {
      window.open(APPROVE_URL);
      this.blocked(token, login, ex, true);
    };
    if (!opened) {
      button(el, "去 GitHub 批准", "primary", open).addClass("is-block");
      el.createEl("p", { cls: "nb-hint", text: `在 ${ex.org} 那一行点 Grant，再回来` });
    } else {
      const retry = button(el, "批准好了，重试", "primary", async () => {
        retry.disabled = true;
        retry.querySelector("span:last-child")?.setText("正在重试…");
        try {
          const r = await findExisting(new GitHubApi(http, token), await this.plugin.readGitConfig());
          if (r?.kind === "ok") return this.existing(token, login, r);
          if (r?.kind === "blocked") return this.blocked(token, login, r, true, true);
          await this.createNew(token, login);
        } catch (e) {
          this.problem(e, () => this.blocked(token, login, ex, true));
        }
      });
      retry.addClass("is-block");
      const hint = el.createEl("p", { cls: "nb-hint", text: again ? "还是读不到，过几秒再试。" : "没看到 Grant？" });
      const a = hint.createEl("a", { text: again ? "再打开批准页" : "再打开一次批准页" });
      a.addEventListener("click", open);
    }
    button(el, "另建一份新的", "ghost", () => {
      el.empty();
      const s = el.createDiv({ cls: "nb-waiting" });
      s.createSpan({ cls: "nb-spin" });
      s.createSpan({ cls: "nb-w", text: "正在建一份新的…" });
      this.createNew(token, login).catch((e) => this.problem(e, () => this.blocked(token, login, ex)));
    }).addClass("is-block");
  }

  /** 认出了已有的备份 */
  private async existing(token: string, login: string, ex: Extract<Existing, { kind: "ok" }>) {
    const info = await describeBackup(ex.remote);
    const gitOn = this.plugin.obsidianGitOn();
    const el = this.contentEl;
    el.empty();
    this.badge(el, "check", "is-ok");
    el.createEl("h3", { text: "找到你已有的备份" });
    el.createEl("p", { cls: "nb-sub", text: "这个笔记库原来就备份在你的 GitHub 里。接着用它，不另建一份，原来的历史都留着。" });
    const card = el.createDiv({ cls: "nb-found" });
    svgIcon(card.createSpan({ cls: "nb-badge" }), "cloud");
    const t = card.createDiv();
    t.createEl("b", { text: ex.full });
    t.createSpan({ text: info ? `${info.count} 篇笔记 · 上次备份：${ago(info.at)}` : "里面还没有笔记" });
    if (gitOn) {
      const n = el.createDiv({ cls: "nb-note" });
      svgIcon(n, "info");
      n.createSpan({ text: "这个笔记库开着 Obsidian Git。两个一起往同一份备份里写会互相打架，接上后帮你把它关掉。" });
    }
    const area = el.createDiv();
    button(area, "接着用它", "primary", async () => {
      area.empty();
      const m = area.createDiv();
      meter(m, "正在对一遍", 0, info?.count ?? 0);
      try {
        await this.plugin.connect(token, login, ex.remote);
        if (gitOn) await this.plugin.turnOffObsidianGit();
      } catch (e) {
        return this.problem(e, () => void this.existing(token, login, ex));
      }
      await this.plugin.syncNow((p) => {
        if (p.phase === "scan") return;
        m.empty();
        meter(m, p.phase === "down" ? "正在取回" : "正在备份", p.done, p.total);
      });
      area.empty();
      const s = this.plugin.status;
      if (s.kind === "error" || s.kind === "off" || s.kind === "paused") {
        area.createEl("p", { cls: "nb-err", text: s.kind === "paused" ? "暂停了。点状态栏的「继续备份」接着对。" : "还没对完，联网后会自动接着做。" });
        return;
      }
      meter(area, "接上了", info?.count ?? 0, info?.count ?? 0, true);
      area.createEl("p", { cls: "nb-sub", text: gitOn ? "Obsidian Git 已经关掉。以后改完它会自己备份，不用再管。" : "以后改完它会自己备份，不用再管。" });
      const n = this.plugin.state.clashes.length;
      if (n) area.createEl("p", { cls: "nb-sub", text: `有 ${n} 篇两边都改了，先用了较新的版本，另一版留着。状态的黄点点开就能对比。` });
      button(area, "好的", "primary", () => this.close()).addClass("is-block");
    }).addClass("is-block");
    button(area, "不用，另建一份新的", "ghost", () => {
      el.empty();
      const w = el.createDiv({ cls: "nb-waiting" });
      w.createSpan({ cls: "nb-spin" });
      w.createSpan({ cls: "nb-w", text: "正在建一份新的…" });
      this.createNew(token, login).catch((e) => this.problem(e, () => void this.existing(token, login, ex)));
    }).addClass("is-block");
  }

  /** 新备份：自动开始第一次备份 */
  private firstBackup(login: string) {
    const el = this.contentEl;
    el.empty();
    this.badge(el, "check", "is-ok");
    el.createEl("h3", { text: "连上了" });
    el.createEl("p", { cls: "nb-sub", text: `账号 ${login}。笔记备份在你账号下的「我的笔记备份」，只有你能看。` });
    const m = el.createDiv();
    const total = this.app.vault.getFiles().length;
    meter(m, "正在做第一次备份", 0, total);
    el.createEl("p", { cls: "nb-sub", text: "以后每次改完，它会自己备份。不用再管它。" });
    const ok = button(el, "好的", "primary", () => this.close());
    ok.addClass("is-block");
    void this.plugin
      .syncNow((p) => {
        if (p.phase !== "up") return;
        m.empty();
        meter(m, "正在做第一次备份", p.done, p.total);
      })
      .then(() => {
        m.empty();
        const s = this.plugin.status;
        if (s.kind === "paused") m.createEl("p", { cls: "nb-sub", text: "暂停了。点状态栏的「继续备份」，从停下的地方接着来。" });
        else if (s.kind === "error" || s.kind === "off") m.createEl("p", { cls: "nb-err", text: "第一次备份没做完，联网后会自动接着做。" });
        else meter(m, "第一次备份好了", total, total, true);
      });
  }

  /** 账号里已有备份：这台是第二台设备 */
  private found(login: string, info: { count: number; at: number; dev: string }) {
    const el = this.contentEl;
    el.empty();
    const localCount = this.app.vault.getFiles().length;
    this.badge(el, "check", "is-ok");
    el.createEl("h3", { text: "找到你的备份" });
    el.createEl("p", {
      cls: "nb-sub",
      text: localCount
        ? `账号 ${login} 里已经有一份备份。这台设备也有 ${localCount} 篇，两边合在一起，一篇都不删。`
        : `账号 ${login} 里已经有一份备份。这台设备的笔记库是空的，直接取回。`,
    });
    const card = el.createDiv({ cls: "nb-found" });
    svgIcon(card.createSpan({ cls: "nb-badge" }), "laptop");
    const t = card.createDiv();
    t.createEl("b", { text: `${info.count} 篇笔记` });
    t.createSpan({ text: `上次备份：${ago(info.at)}${info.dev ? `，在 ${info.dev}` : ""}` });
    const area = el.createDiv();
    const go = button(area, localCount ? "合在一起" : `取回 ${info.count} 篇`, "primary", () => {
      area.empty();
      const m = area.createDiv();
      meter(m, "正在取回", 0, info.count);
      area.createEl("p", { cls: "nb-sub nb-small", text: "可以先去做别的，取回不会断。" });
      void this.plugin
        .syncNow((p) => {
          if (p.phase !== "down") return;
          m.empty();
          meter(m, localCount ? "正在合在一起" : "正在取回", p.done, p.total);
        })
        .then(() => {
          area.empty();
          const s = this.plugin.status;
          if (s.kind === "error" || s.kind === "off" || s.kind === "paused") {
            area.createEl("p", { cls: "nb-err", text: s.kind === "paused" ? "暂停了。点状态栏的「继续备份」接着取。" : "没取完，联网后会自动接着取。" });
            return;
          }
          meter(area, localCount ? "合好了" : "取回好了", info.count, info.count, true);
          area.createEl("p", { cls: "nb-sub", text: "以后两台设备自动保持一样。" });
          const n = this.plugin.state.clashes.length;
          if (n) area.createEl("p", { cls: "nb-sub", text: `有 ${n} 篇两边都改了，先用了较新的版本，另一版留着。状态的黄点点开就能对比。` });
          button(area, "打开笔记", "primary", () => this.close()).addClass("is-block");
        });
    });
    go.addClass("is-block");
  }
}
