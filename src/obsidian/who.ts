/**
 * [INPUT]: Obsidian 的 workspace / vault 事件
 * [OUTPUT]: WhoTracker 给每次改动标上「我」或「AI」
 * [POS]: obsidian 层的归属判定。规则(老板 2026-10-29 定)：编辑器里改的算我，编辑器外改的算 AI；手机上都算我
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Plugin, TAbstractFile } from "obsidian";
import { TFile } from "obsidian";
import type { Who } from "../core/types";

/** 外部改动让打开着的笔记重新加载时，编辑器也会报一次改动；这段时间内不算「我」 */
const RELOAD_WINDOW = 1500;

export class WhoTracker {
  private typed = new Set<string>();
  private quiet = new Map<string, number>();

  constructor(
    private plugin: Plugin,
    private mobile: boolean,
    private isOwnWrite: (path: string) => boolean,
    private mark: (path: string, who: Who) => void,
  ) {}

  register() {
    const { workspace, vault } = this.plugin.app;
    this.plugin.registerEvent(
      workspace.on("editor-change", (_editor, info) => {
        const path = info.file?.path;
        if (!path || (this.quiet.get(path) ?? 0) > Date.now()) return;
        this.typed.add(path);
      }),
    );
    this.plugin.registerEvent(vault.on("modify", (f) => this.onModify(f)));
    /* 新建、删除、改名分不出来源：Obsidian 窗口在前台算我，否则算 AI */
    this.plugin.registerEvent(vault.on("create", (f) => this.onOther(f.path, f)));
    this.plugin.registerEvent(vault.on("delete", (f) => this.onOther(f.path, f)));
    this.plugin.registerEvent(
      vault.on("rename", (f, old) => {
        this.onOther(old, f);
        this.onOther(f.path, f);
      }),
    );
  }

  private onModify(f: TAbstractFile) {
    if (!(f instanceof TFile) || this.isOwnWrite(f.path)) return;
    const who: Who = this.mobile || this.typed.delete(f.path) ? "me" : "ai";
    if (who === "ai") this.quiet.set(f.path, Date.now() + RELOAD_WINDOW);
    this.mark(f.path, who);
  }

  private onOther(path: string, f: TAbstractFile) {
    if (!(f instanceof TFile) || this.isOwnWrite(path)) return;
    this.mark(path, this.mobile || document.hasFocus() ? "me" : "ai");
  }

  /** 同步自己写进去的内容会让编辑器重新加载，也要静默一下 */
  hush(path: string) {
    this.quiet.set(path, Date.now() + RELOAD_WINDOW);
    this.typed.delete(path);
  }
}
