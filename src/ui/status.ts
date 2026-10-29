/**
 * [INPUT]: 插件本体的 status 与 subscribe
 * [OUTPUT]: StatusUI 电脑底部状态栏 + 点开的小卡；手机笔记顶栏的云朵 + 底部卡片
 * [POS]: 设计稿第 2 屏。一个点四种意思：绿 = 好了，闪 = 在跑，黄 = 要你看一眼，空心 = 没网；只有黄色要用户动手
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { MarkdownView, Modal, Platform, setIcon, type App } from "obsidian";
import type NoteBackupPlugin from "../main";
import type { Status } from "../main";
import { ago, button, chip, dot, hhmm, meter, noteName, type DotKind } from "./kit";

const DOT: Record<Status["kind"], DotKind> = { setup: "off", ok: "ok", run: "run", warn: "warn", off: "off", paused: "off", error: "warn" };

/** 状态栏那一句话 */
export function barText(s: Status): string {
  switch (s.kind) {
    case "setup":
      return "还没开启备份";
    case "ok":
      return `已备份 · ${ago(s.at)}`;
    case "run":
      return s.phase === "down" ? `正在取回 ${s.total} 篇…` : `正在备份 ${s.files.length || s.total} 篇…`;
    case "warn":
      return `${s.clashes.length} 篇两边都改了`;
    case "off":
      return "没网 · 联网后自动补上";
    case "paused":
      return "已暂停备份";
    case "error":
      return "备份没成功";
  }
}

function files(el: HTMLElement, paths: string[]) {
  /* 一次几十上百篇时，列篇名只是噪音，看进度条就够了 */
  if (!paths.length || paths.length > 12) return;
  const box = el.createDiv({ cls: "nb-st-files" });
  for (const p of paths.slice(0, 6)) chip(box, noteName(p), "file");
  if (paths.length > 6) chip(box, `等 ${paths.length} 篇`);
}

/** 点开后的细节，电脑小卡和手机底部卡片共用 */
export function renderDetail(el: HTMLElement, plugin: NoteBackupPlugin, close: () => void) {
  el.empty();
  const s = plugin.status;
  const title = el.createDiv({ cls: "nb-st-title" });
  dot(title, DOT[s.kind]);
  const body = el.createEl("p", { cls: "nb-st-body" });
  const acts = () => el.createDiv({ cls: "nb-st-acts" });
  switch (s.kind) {
    case "setup":
      title.appendText("还没开启备份");
      body.setText("登录一次 GitHub，笔记就会自动备份，换设备也能取回。");
      button(acts(), "开启备份", "primary", () => (close(), plugin.openLogin()));
      return;
    case "ok":
      title.appendText("都备份好了");
      body.setText(s.at ? `${ago(s.at)}备份了 ${s.files.length} 篇。` : "笔记和你的备份一样。");
      if (!s.files.length && s.at) body.setText(`${ago(s.at)}对过一遍，笔记和你的备份一样。`);
      files(el, s.files);
      button(acts(), "看同步记录", "tag", () => (close(), plugin.openLog()));
      return;
    case "run":
      title.appendText(s.phase === "down" ? "正在取回" : "正在备份");
      body.setText(s.total > 50 ? "篇数多，要几分钟。不用等，接着写；中途暂停也不丢进度。" : "几秒就好。不用等，接着写。");
      files(el, s.files);
      if (s.total > 1) meter(el.createDiv({ cls: "nb-st-meter" }), s.phase === "down" ? "取回" : "备份", s.done, s.total);
      button(acts(), "暂停", "tag", () => void plugin.pause());
      return;
    case "paused":
      title.appendText("备份暂停了");
      body.appendText("改动先存在这台设备上");
      if (s.pending.length) {
        body.appendText("，已攒 ");
        body.createEl("b", { text: `${s.pending.length} 篇` });
      }
      body.appendText("。点继续，从停下的地方接着备份。");
      files(el, s.pending);
      button(acts(), "继续备份", "primary", () => (close(), void plugin.resume()));
      return;
    case "warn": {
      const c = s.clashes[0];
      title.appendText(s.clashes.length === 1 ? `${noteName(c.path)} 两边都改了` : `${s.clashes.length} 篇两边都改了`);
      body.appendText(`${c.winnerLabel.dev} ${hhmm(c.winnerLabel.t)} 和 ${c.loserLabel.dev} ${hhmm(c.loserLabel.t)} 改了同一段。先用了较新的`);
      body.createEl("b", { text: `${c.winnerLabel.dev}版` });
      body.appendText(`，${c.loserLabel.dev}版留着，随时能对比。`);
      if (s.clashes.length > 1) {
        const box = el.createDiv({ cls: "nb-st-files" });
        for (const x of s.clashes) {
          const k = chip(box, noteName(x.path), "file");
          k.addClass("is-link");
          k.addEventListener("click", () => (close(), plugin.openMerge(x.path)));
        }
      }
      const a = acts();
      button(a, "点开合并", "primary", () => (close(), plugin.openMerge(c.path)));
      button(a, "稍后", "ghost", close);
      return;
    }
    case "off":
      title.appendText("现在没网");
      body.appendText("改动先存在这台设备上，已攒 ");
      body.createEl("b", { text: `${s.pending.length} 篇` });
      body.appendText("。联网后自动补上，不用管。");
      files(el, s.pending);
      return;
    case "error":
      title.appendText("备份没成功");
      body.setText(s.message);
      if (s.relogin) button(acts(), "重新登录", "primary", () => (close(), plugin.openLogin()));
      else button(acts(), "再试一次", "tag", () => (close(), plugin.syncNow()));
      return;
  }
}

/** 手机：底部卡片 */
class StatusSheet extends Modal {
  private off: (() => void) | null = null;
  constructor(app: App, private plugin: NoteBackupPlugin) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("nb-sheet");
    const draw = () => renderDetail(this.contentEl, this.plugin, () => this.close());
    draw();
    this.off = this.plugin.subscribe(draw);
  }
  onClose() {
    this.off?.();
    this.contentEl.empty();
  }
}

export class StatusUI {
  private bar: HTMLElement | null = null;
  private pop: HTMLElement | null = null;
  private actions = new WeakMap<MarkdownView, HTMLElement>();

  constructor(private plugin: NoteBackupPlugin) {}

  mount() {
    const p = this.plugin;
    if (!Platform.isMobile) {
      this.bar = p.addStatusBarItem();
      this.bar.addClass("nb-sync", "mod-clickable");
      this.bar.setAttr("aria-label", "笔记备份");
      this.bar.addEventListener("click", (e) => {
        e.stopPropagation();
        if (p.status.kind === "setup") return p.openLogin();
        this.toggle();
      });
      p.registerDomEvent(document, "click", (e) => {
        if (this.pop && !this.pop.contains(e.target as Node)) this.closePop();
      });
    } else {
      /* 手机没有状态栏：放在每篇笔记顶栏的云朵上 */
      const attach = () => {
        for (const leaf of p.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view as MarkdownView;
          if (this.actions.has(view)) continue;
          const el = view.addAction("nb-cloud", "笔记备份", () => (p.status.kind === "setup" ? p.openLogin() : new StatusSheet(p.app, p).open()));
          el.addClass("nb-head-action");
          this.actions.set(view, el);
        }
        this.render();
      };
      p.registerEvent(p.app.workspace.on("layout-change", attach));
      p.app.workspace.onLayoutReady(attach);
    }
    p.subscribe(() => this.render());
    this.render();
  }

  private render() {
    const s = this.plugin.status;
    if (this.bar) {
      this.bar.empty();
      this.bar.toggleClass("is-warn", s.kind === "warn");
      dot(this.bar, DOT[s.kind]);
      this.bar.createSpan({ text: barText(s) });
    }
    if (this.pop) renderDetail(this.pop, this.plugin, () => this.closePop());
    const icon = s.kind === "off" || s.kind === "paused" ? "nb-cloud-off" : s.kind === "run" ? "nb-sync" : s.kind === "ok" ? "nb-cloud-ok" : "nb-cloud";
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const el = this.actions.get(leaf.view as MarkdownView);
      if (!el) continue;
      setIcon(el, icon);
      el.toggleClass("is-warn", s.kind === "warn" || s.kind === "error");
    }
  }

  private toggle() {
    if (this.pop) return this.closePop();
    this.pop = document.body.createDiv({ cls: "nb-pop" });
    renderDetail(this.pop, this.plugin, () => this.closePop());
    const r = this.bar?.getBoundingClientRect();
    if (r) {
      this.pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      this.pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
    }
  }

  private closePop() {
    this.pop?.remove();
    this.pop = null;
  }
}

