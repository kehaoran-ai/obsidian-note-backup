/**
 * [INPUT]: 插件本体的 log.versions(某篇的每一版)、remote.readBlob(取某一版内容)、writeAsMe(恢复)
 * [OUTPUT]: HistoryView 某篇的历史版本：左边每一版，右边内容(和现在不一样的行灰底)，可恢复，可撤销
 * [POS]: 设计稿第 3 屏右半。恢复不删现在这版：恢复本身也是一次备份，现在那版留在历史里
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ItemView, Platform, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { asText, gitBlobSha } from "../core/bytes";
import { changedLines, splitLines } from "../core/merge";
import type { Who } from "../core/types";
import type NoteBackupPlugin from "../main";
import { button, dayLabel, hhmm, noteName, toast } from "./kit";
import { svgIcon } from "./icons";

export const HISTORY_VIEW = "note-backup-history";

interface Ver {
  h: string | null;
  t: number;
  who: Who;
  dev: string;
  s: string;
}

export class HistoryView extends ItemView {
  private path = "";
  private ver = 0;
  private cache = new Map<string, Uint8Array>();
  private current: { text: string | null; sha: string | null } = { text: null, sha: null };

  constructor(leaf: WorkspaceLeaf, private plugin: NoteBackupPlugin) {
    super(leaf);
  }

  getViewType() {
    return HISTORY_VIEW;
  }
  getDisplayText() {
    return this.path ? `${noteName(this.path)} · 历史版本` : "历史版本";
  }
  getIcon() {
    return "clock";
  }

  getState() {
    return { path: this.path, ver: this.ver };
  }

  async setState(state: { path?: string; ver?: number }, result: ViewStateResult) {
    this.path = state.path ?? this.path;
    this.ver = state.ver ?? 0;
    await super.setState(state, result);
    await this.reload();
  }

  async onOpen() {
    this.contentEl.addClass("nb-hist-view");
    if (Platform.isMobile) this.contentEl.addClass("is-mobile");
  }

  private versions(): Ver[] {
    return this.plugin.log.versions(this.path);
  }

  private async reload() {
    const f = this.app.vault.getAbstractFileByPath(this.path);
    if (f instanceof TFile) {
      const data = new Uint8Array(await this.app.vault.readBinary(f));
      this.current = { text: asText(data), sha: await gitBlobSha(data) };
    } else this.current = { text: null, sha: null };
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText());
    this.render();
  }

  private async content(h: string): Promise<Uint8Array> {
    const hit = this.cache.get(h);
    if (hit) return hit;
    if (!this.plugin.remote) throw new Error("还没连上");
    const data = await this.plugin.remote.readBlob(h);
    this.cache.set(h, data);
    return data;
  }

  private label(v: Ver, i: number) {
    const now = v.h !== null && v.h === this.current.sha && i === 0;
    return `${dayLabel(v.t).short} ${hhmm(v.t)}${now ? " · 现在" : ""}`;
  }

  private isNow(v: Ver, i: number) {
    return i === 0 && v.h !== null && v.h === this.current.sha;
  }

  /** 第二行：改了什么；别的设备改的才带设备名 */
  private detail(v: Ver) {
    const other = v.dev && v.dev !== this.plugin.settings.device ? ` · ${v.dev}` : "";
    return `${v.s}${other}`;
  }

  /** 每一版的列表：按天分组，一行只写几点和改了什么 */
  private verList(parent: HTMLElement, vs: Ver[], onPick: (i: number) => void, after?: (item: HTMLElement, v: Ver, i: number) => void) {
    let day = "";
    vs.forEach((v, i) => {
      const d = dayLabel(v.t).short;
      if (d !== day) {
        day = d;
        parent.createDiv({ cls: "nb-ver-day", text: d });
      }
      const item = parent.createDiv({ cls: "nb-ph-item" });
      this.verButton(item, v, i, () => onPick(i));
      after?.(item, v, i);
    });
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    const vs = this.versions();
    if (!vs.length) {
      el.createDiv({ cls: "nb-empty", text: "这篇还没有备份过的版本。" });
      return;
    }
    if (this.ver >= vs.length) this.ver = 0;
    if (Platform.isMobile) return this.renderMobile(el, vs);

    const wrap = el.createDiv({ cls: "nb-hist" });
    const list = wrap.createDiv({ cls: "nb-vers" });
    this.verList(list, vs, (i) => ((this.ver = i), this.render()));
    const prev = wrap.createDiv({ cls: "nb-prev" });
    const v = vs[this.ver];
    const h = prev.createDiv({ cls: "nb-prev-h" });
    h.createEl("b", { text: noteName(this.path) });
    h.createSpan({ text: `${this.label(v, this.ver)} · ${v.who === "me" ? "我" : "AI"} · ${this.detail(v)}` });
    const lines = prev.createDiv({ cls: "nb-lines" });
    const foot = prev.createDiv({ cls: "nb-prev-f" });
    const note = foot.createSpan();
    const legend = note.createSpan({ cls: "nb-legend" });
    legend.createEl("i");
    legend.appendText("灰底 = 和现在不一样的行");
    note.createEl("br");
    const tip = note.createSpan();
    const isNow = v.h !== null && v.h === this.current.sha;
    tip.setText(v.h === null ? "这一版是删掉的。" : isNow ? "这就是现在的版本。点左边一版看看。" : "恢复后，现在这版留在历史里。");
    const btn = button(foot, "恢复这个版本", "primary", () => void this.restore(v));
    btn.disabled = v.h === null || isNow;
    void this.paintLines(lines, v);
  }

  private verButton(parent: HTMLElement, v: Ver, i: number, onClick: () => void) {
    const b = parent.createEl("button", { cls: `nb-ver${i === this.ver ? " is-on" : ""}`, attr: { title: `${v.who === "me" ? "我" : "AI"} · ${v.dev} · ${v.s}` } });
    const who = b.createSpan({ cls: `nb-who is-${v.who}` });
    if (v.who === "me") who.setText("我");
    else svgIcon(who, "spark");
    const t = b.createSpan({ cls: "nb-ver-t" });
    const top = t.createSpan({ cls: "nb-ver-top" });
    top.createEl("b", { text: hhmm(v.t) });
    if (this.isNow(v, i)) top.createSpan({ cls: "nb-now", text: "现在" });
    t.createSpan({ cls: "nb-ver-s", text: this.detail(v) });
    b.addEventListener("click", onClick);
    return b;
  }

  private async paintLines(box: HTMLElement, v: Ver) {
    box.empty();
    if (v.h === null) {
      box.createDiv({ cls: "nb-empty", text: "这一版把这篇删掉了。" });
      return;
    }
    box.createDiv({ cls: "nb-empty", text: "正在取这一版…" });
    let text: string | null;
    try {
      text = asText(await this.content(v.h));
    } catch {
      box.empty();
      box.createDiv({ cls: "nb-empty", text: "取不到这一版，联网后再看。" });
      return;
    }
    box.empty();
    if (text === null) {
      box.createDiv({ cls: "nb-empty", text: "这是附件，不能预览。可以直接恢复。" });
      return;
    }
    const ls = splitLines(text);
    const flags = changedLines(ls, splitLines(this.current.text ?? ""));
    ls.forEach((l, k) => {
      const row = box.createDiv({ cls: "nb-ln" });
      if (flags[k] && this.current.text !== null) row.addClass("is-chg");
      if (/^#{1,6}\s/.test(l)) row.addClass("is-h");
      row.createEl("i", { text: String(k + 1) });
      row.createSpan({ text: l });
    });
  }

  private renderMobile(el: HTMLElement, vs: Ver[]) {
    const body = el.createDiv({ cls: "nb-ph-body" });
    this.verList(body, vs, (i) => ((this.ver = i), this.render()), (item, v, i) => {
      if (i !== this.ver) return;
      const lines = item.createDiv({ cls: "nb-lines is-boxed" });
      void this.paintLines(lines, v);
      const isNow = v.h !== null && v.h === this.current.sha;
      if (isNow) item.createEl("p", { cls: "nb-sub nb-small", text: "这就是现在的版本。" });
      else if (v.h !== null) button(item, "恢复这个版本", "primary", () => void this.restore(v)).addClass("is-block");
    });
  }

  private async restore(v: Ver) {
    if (!v.h) return;
    const data = await this.content(v.h);
    const f = this.app.vault.getAbstractFileByPath(this.path);
    const label = `${dayLabel(v.t).short} ${hhmm(v.t)}`;
    if (f instanceof TFile) {
      const before = new Uint8Array(await this.app.vault.readBinary(f));
      await this.writeBack(f, data);
      toast(`${noteName(this.path)} 已恢复到 ${label} 那版 · 现在那版在历史里`, {
        label: "撤销",
        run: () => void this.writeBack(f, before).then(() => this.reload()),
      });
    } else {
      /* 这篇已经删了：按那一版重新建出来 */
      this.plugin.markOwnWrite(this.path);
      const text = asText(data);
      if (text !== null) await this.app.vault.create(this.path, text);
      else await this.app.vault.createBinary(this.path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      this.plugin.state.who[this.path] = "me";
      toast(`${noteName(this.path)} 已恢复到 ${label} 那版`);
    }
    this.plugin.syncSoon(1500);
    await this.reload();
  }

  private async writeBack(f: TFile, data: Uint8Array) {
    const text = asText(data);
    if (text !== null) await this.plugin.writeAsMe(f, text);
    else {
      this.plugin.markOwnWrite(f.path);
      await this.app.vault.modifyBinary(f, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      this.plugin.state.who[f.path] = "me";
    }
    this.plugin.syncSoon(1500);
  }
}
