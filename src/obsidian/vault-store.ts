/**
 * [INPUT]: Obsidian 的 App(vault、vault.adapter、fileManager)，core 的文本判定与 LocalStore 契约
 * [OUTPUT]: VaultStore 把笔记库包成引擎认的 LocalStore
 * [POS]: obsidian 层的本地读写。只走 vault 接口，电脑和手机同一套；peek 绕开文件信息缓存直读磁盘；删除进回收站，不直接抹掉
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { App, normalizePath, TFile, TFolder } from "obsidian";
import { asText } from "../core/bytes";
import type { LocalEntry, LocalStore } from "../core/types";

export class VaultStore implements LocalStore {
  /** onOwnWrite：同步自己写的，告诉「谁改的」判定别算进去 */
  constructor(private app: App, private onOwnWrite: (path: string) => void) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  async list(): Promise<LocalEntry[]> {
    return this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  async stat(path: string): Promise<LocalEntry | null> {
    const f = this.file(path);
    return f ? { path, mtime: f.stat.mtime, size: f.stat.size } : null;
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.file(path);
    if (!f) throw new Error(`找不到 ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(f));
  }

  /* TFile.stat 是 Obsidian 的缓存，外部进程刚写完时还是旧的；adapter 直接问磁盘 */
  async peek(path: string): Promise<Uint8Array | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path, true))) return null;
    return new Uint8Array(await adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.onOwnWrite(path);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    /* 文本走 modify，打开着的笔记会跟着刷新 */
    const text = path.endsWith(".md") || path.endsWith(".canvas") ? asText(data) : null;
    const f = this.file(path);
    if (f) {
      if (text !== null) await this.app.vault.modify(f, text);
      else await this.app.vault.modifyBinary(f, buf);
      return;
    }
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    if (text !== null) await this.app.vault.create(path, text);
    else await this.app.vault.createBinary(path, buf);
  }

  async remove(path: string): Promise<void> {
    const f = this.file(path);
    if (!f) return;
    this.onOwnWrite(path);
    /* 按用户的回收站设置走，删错了还能找回来 */
    await this.app.fileManager.trashFile(f);
  }

  private async ensureFolder(dir: string) {
    if (!dir) return;
    const p = normalizePath(dir);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFolder) return;
    await this.ensureFolder(p.split("/").slice(0, -1).join("/"));
    try {
      await this.app.vault.createFolder(p);
    } catch {
      /* 并发时可能已经建好了 */
    }
  }
}
