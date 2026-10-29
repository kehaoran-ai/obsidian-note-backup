/**
 * [INPUT]: 插件本体的 state.clashes(两边都改了的记录)、core 的 mergeBlocks / assemble / wordMarks
 * [OUTPUT]: MergeView 合并页：电脑左右两栏，手机一次一处上下排；每处选留左边 / 留右边 / 都要
 * [POS]: 设计稿第 4 屏，冲突三层的第 3 层。选完或点「不用选，就用现在的」，黄点才变回绿
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { ItemView, Platform, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { asText } from "../core/bytes";
import { assemble, mergeBlocks, splitLines, wordMarks, type Block, type Pick, type Seg } from "../core/merge";
import type { Clash } from "../core/types";
import type NoteBackupPlugin from "../main";
import { svgIcon } from "./icons";
import { button, chip, dot, hhmm, noteName, toast } from "./kit";

export const MERGE_VIEW = "note-backup-merge";

const LBL: Record<Pick, string> = { now: "留左边", old: "留右边", both: "都要" };
const LBLM: Record<Pick, string> = { now: "留上面", old: "留下面", both: "都要" };

export class MergeView extends ItemView {
  private path = "";
  private clash: Clash | null = null;
  private current = "";
  private blocks: Block[] = [];
  private conf: number[] = [];
  private picks: Record<number, Pick> = {};
  private cur = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: NoteBackupPlugin) {
    super(leaf);
  }

  getViewType() {
    return MERGE_VIEW;
  }
  getDisplayText() {
    return this.path ? `${noteName(this.path)} · 两边都改了` : "两边都改了";
  }
  getIcon() {
    return "nb-cloud";
  }
  getState() {
    return { path: this.path };
  }

  async setState(state: { path?: string }, result: ViewStateResult) {
    this.path = state.path ?? this.path;
    await super.setState(state, result);
    await this.reload();
  }

  async onOpen() {
    this.contentEl.addClass("nb-merge");
    if (Platform.isMobile) this.contentEl.addClass("is-mobile");
  }

  private async reload() {
    this.clash = this.plugin.state.clashes.find((c) => c.path === this.path) ?? null;
    this.picks = {};
    this.cur = 0;
    const f = this.app.vault.getAbstractFileByPath(this.path);
    this.current = f instanceof TFile ? asText(new Uint8Array(await this.app.vault.readBinary(f))) ?? "" : "";
    if (this.clash && !this.clash.binary) {
      this.blocks = mergeBlocks(this.current, this.clash.base, this.clash.loser);
      this.conf = this.blocks.map((b, i) => (b.kind === "clash" ? i : -1)).filter((i) => i >= 0);
    } else {
      this.blocks = [];
      this.conf = [];
    }
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText());
    this.render();
  }

  private get left() {
    return this.conf.filter((i) => !this.picks[i]).length;
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    const c = this.clash;
    if (!c) {
      const e = el.createDiv({ cls: "nb-empty" });
      e.createDiv({ text: "这篇已经合好了。" });
      button(e.createDiv(), "关掉", "tag", () => this.leaf.detach());
      return;
    }
    if (c.binary) return this.renderBinary(el, c);
    if (Platform.isMobile) return this.renderMobile(el, c);

    const h = el.createDiv({ cls: "nb-mg-h" });
    dot(h, this.left ? "warn" : "ok");
    h.createEl("b", { text: noteName(this.path) });
    h.createSpan({
      cls: "nb-muted nb-cnt",
      text: this.left ? `还有 ${this.left} 处没选 · 共 ${this.conf.length} 处` : `${this.conf.length} 处都选好了`,
    });
    h.createSpan({ cls: "nb-sp" });
    button(h, "不用选，就用现在的", "ghost", () => void this.keepCurrent());
    const done = button(h, "完成", "primary", () => void this.finish());
    done.disabled = this.left > 0;

    const cols = el.createDiv({ cls: "nb-mg-cols" });
    const col = (b: string, rest: string) => {
      const d = cols.createDiv();
      d.createEl("b", { text: b });
      d.appendText(` · ${rest}`);
    };
    col("现在的", `${c.winnerLabel.dev} ${hhmm(c.winnerLabel.t)} 改的`);
    col("被盖掉的", `${c.loserLabel.dev} ${hhmm(c.loserLabel.t)} 改的`);

    const rows = el.createDiv({ cls: "nb-mg-rows" });
    let ln = 0;
    let rn = 0;
    this.blocks.forEach((b, i) => {
      if (b.kind !== "clash") {
        for (const line of b.lines) {
          const r = rows.createDiv({ cls: "nb-mrow" });
          this.cell(r, ++ln, [{ s: line, mark: false }], line);
          this.cell(r, ++rn, [{ s: line, mark: false }], line);
        }
        if (b.kind === "auto") {
          const a = rows.createDiv({ cls: "nb-auto" });
          chip(a, `这${b.lines.length > 1 ? "几" : "一"}行只有${c.loserLabel.dev}改了，已经自动合进来`, "check");
        }
        return;
      }
      const p = this.picks[i];
      const r = rows.createDiv({ cls: "nb-mrow is-c" });
      const w = wordMarks(b.now, b.old);
      const side = (lines: string[], marks: Seg[][], start: number, which: "now" | "old") => {
        const cell = r.createDiv({ cls: "nb-cell-group" });
        if (p) cell.addClass(p === "both" || p === which ? "is-keep" : "is-drop");
        if (!lines.length) cell.createDiv({ cls: "nb-cell is-empty", text: "（这边删掉了）" });
        lines.forEach((l, k) => this.cell(cell, start + k + 1, marks[k] ?? [{ s: l, mark: false }], l));
      };
      side(b.now, w.now, ln, "now");
      side(b.old, w.old, rn, "old");
      ln += b.now.length;
      rn += b.old.length;
      const pick = r.createDiv({ cls: "nb-pick" });
      pick.createEl("small", { text: `第 ${this.conf.indexOf(i) + 1} 处` });
      for (const s of ["now", "old", "both"] as Pick[]) {
        const t = button(pick, LBL[s], "tag-sm", () => {
          this.picks[i] = s;
          this.render();
        });
        if (p === s) t.addClass("is-on");
      }
    });
  }

  private cell(parent: HTMLElement, n: number, segs: Seg[], raw: string) {
    const c = parent.createDiv({ cls: "nb-cell" });
    if (/^#{1,6}\s/.test(raw)) c.addClass("is-h");
    c.createEl("i", { text: String(n) });
    const s = c.createSpan();
    for (const g of segs) {
      if (g.mark) s.createEl("mark", { text: g.s });
      else s.appendText(g.s);
    }
  }

  /* ---------- 手机：一次一处 ---------- */
  private renderMobile(el: HTMLElement, c: Clash) {
    const body = el.createDiv({ cls: "nb-pm" });
    const all = this.conf.every((i) => this.picks[i]);
    const top = body.createDiv({ cls: "nb-pm-top" });
    const dots = () => {
      const d = top.createSpan({ cls: "nb-pm-dots" });
      this.conf.forEach((i, k) => d.createEl("i", { cls: this.picks[i] ? "is-done" : k === this.cur && !all ? "is-cur" : "" }));
    };
    if (!this.conf.length || (all && this.cur >= this.conf.length)) {
      dot(top, "ok");
      top.appendText(this.conf.length ? `${this.conf.length} 处都选好了` : "两边已经一样了");
      dots();
      const lines = body.createDiv({ cls: "nb-lines is-boxed" });
      const text = assemble(this.blocks, this.picks);
      splitLines(text).forEach((l, k) => {
        const row = lines.createDiv({ cls: "nb-ln" });
        row.createEl("i", { text: String(k + 1) });
        row.createSpan({ text: l });
      });
      body.createEl("p", { cls: "nb-sub nb-small", text: "点完成，两台设备都变成这版。" });
      button(body, "完成", "primary", () => void this.finish()).addClass("is-block");
      if (this.conf.length) button(body, "回去改", "ghost", () => ((this.cur = 0), this.render())).addClass("is-block");
      return;
    }
    const i = this.conf[this.cur];
    const b = this.blocks[i] as Extract<Block, { kind: "clash" }>;
    const p = this.picks[i];
    dot(top, "warn");
    top.appendText(`第 ${this.cur + 1} 处 · 共 ${this.conf.length} 处`);
    dots();
    const w = wordMarks(b.now, b.old);
    const card = (title: string, label: string, lines: string[], marks: Seg[][], which: "now" | "old") => {
      const sc = body.createDiv({ cls: "nb-side-card" });
      if (p) sc.addClass(p === "both" || p === which ? "is-keep" : "is-drop");
      const s = sc.createEl("small");
      s.createEl("b", { text: title });
      s.appendText(` · ${label}`);
      if (!lines.length) sc.createEl("p", { text: "（这边删掉了）" });
      lines.forEach((_, k) => {
        const para = sc.createEl("p");
        for (const g of marks[k] ?? []) {
          if (g.mark) para.createEl("mark", { text: g.s });
          else para.appendText(g.s);
        }
      });
    };
    card("现在的", `${c.winnerLabel.dev} ${hhmm(c.winnerLabel.t)}`, b.now, w.now, "now");
    card("被盖掉的", `${c.loserLabel.dev} ${hhmm(c.loserLabel.t)}`, b.old, w.old, "old");
    const pick = body.createDiv({ cls: "nb-pm-pick" });
    for (const s of ["now", "old", "both"] as Pick[]) {
      const t = button(pick, LBLM[s], "tag", () => {
        this.picks[i] = s;
        this.render();
        window.setTimeout(() => {
          const next = this.conf.findIndex((x) => !this.picks[x]);
          this.cur = next === -1 ? this.conf.length : next;
          this.render();
        }, 380);
      });
      if (p === s) t.addClass("is-on");
    }
    const nav = body.createDiv({ cls: "nb-pm-nav" });
    const prev = button(nav, "上一处", "ghost", () => ((this.cur = Math.max(0, this.cur - 1)), this.render()));
    prev.disabled = this.cur === 0;
    const next = button(nav, this.cur === this.conf.length - 1 ? "看结果" : "下一处", "ghost", () => {
      this.cur += 1;
      if (this.cur >= this.conf.length && !this.conf.every((x) => this.picks[x])) this.cur = this.conf.findIndex((x) => !this.picks[x]);
      this.render();
    });
    next.disabled = !p;
    const autos = this.blocks.filter((x) => x.kind === "auto").length;
    if (autos) body.createEl("p", { cls: "nb-sub nb-small", text: `${noteName(this.path)}里还有 ${autos} 处只有一边改的，已经自动合好。` });
  }

  /* ---------- 附件：整份选 ---------- */
  private renderBinary(el: HTMLElement, c: Clash) {
    const box = el.createDiv({ cls: "nb-empty" });
    svgIcon(box, "file");
    box.createEl("p", { text: `${noteName(this.path)} 是附件，合不了，只能整份选。` });
    box.createEl("p", { cls: "nb-sub", text: `现在用的是 ${c.winnerLabel.dev} ${hhmm(c.winnerLabel.t)} 的；被盖掉的是 ${c.loserLabel.dev} ${hhmm(c.loserLabel.t)} 的。` });
    const a = box.createDiv({ cls: "nb-st-acts" });
    button(a, "留现在的", "primary", () => void this.keepCurrent());
    button(a, "换成被盖掉的", "tag", async () => {
      const remote = this.plugin.remote;
      const f = this.app.vault.getAbstractFileByPath(this.path);
      if (!remote || !(f instanceof TFile)) return;
      const data = await remote.readBlob(c.loser);
      this.plugin.markOwnWrite(f.path);
      await this.app.vault.modifyBinary(f, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      this.plugin.state.who[f.path] = "me";
      await this.done(`${noteName(this.path)} 换成了被盖掉的那份`);
    });
  }

  private async keepCurrent() {
    await this.plugin.resolveClash(this.path);
    toast("用了现在的版本 · 被盖掉的那版还在同步记录里");
    this.leaf.detach();
  }

  private async finish() {
    const text = assemble(this.blocks, this.picks);
    const f = this.app.vault.getAbstractFileByPath(this.path);
    if (f instanceof TFile && text !== this.current) await this.plugin.writeAsMe(f, text);
    await this.done(`${noteName(this.path)}合好了`);
  }

  private async done(msg: string) {
    await this.plugin.resolveClash(this.path);
    this.leaf.detach();
    await this.plugin.syncNow();
    const s = this.plugin.status.kind;
    toast(s === "ok" ? `${msg}，已备份 · 黄点变回绿点` : `${msg}，联网后自动备份`);
  }
}
