/**
 * [INPUT]: 插件本体的 settings / connect / disconnect / syncNow
 * [OUTPUT]: SettingsTab 设置页：账号、这台设备的名字、立即备份、在 GitHub 上看你的备份
 * [POS]: ui 的设置入口。字面上不出现 Git 术语
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { PluginSettingTab, Setting, type App } from "obsidian";
import type NoteBackupPlugin from "../main";
import { barText } from "./status";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: NoteBackupPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl: el, plugin } = this;
    el.empty();
    const a = plugin.settings.account;
    new Setting(el)
      .setName("GitHub 账号")
      .setDesc(a ? `已连上 ${a.login} · ${barText(plugin.status)}` : "还没连上。登录一次，之后全自动。")
      .addButton((b) =>
        a
          ? b.setButtonText("退出登录").onClick(async () => {
              await plugin.disconnect();
              this.display();
            })
          : b.setButtonText("登录 GitHub").setCta().onClick(() => plugin.openLogin()),
      );
    new Setting(el)
      .setName("这台设备的名字")
      .setDesc("同步记录里用它分清是哪台设备改的。")
      .addText((t) =>
        t.setValue(plugin.settings.device).onChange(async (v) => {
          plugin.settings.device = v.trim() || plugin.settings.device;
          await plugin.saveSettings();
        }),
      );
    if (!a) return;
    new Setting(el)
      .setName("暂停自动备份")
      .setDesc("打开后不备份也不取回，改动先存在这台设备上；关掉就从停下的地方接着来。")
      .addToggle((t) =>
        t.setValue(!!plugin.settings.paused).onChange(async (v) => {
          if (v) await plugin.pause();
          else await plugin.resume();
        }),
      );
    new Setting(el)
      .setName("立即备份")
      .setDesc("平时不用点：改完会自己备份，也会自己取回别的设备的改动。")
      .addButton((b) => b.setButtonText("现在备份").onClick(() => plugin.syncNow()));
    new Setting(el)
      .setName("你的备份")
      .setDesc("放在你账号下的「我的笔记备份」，只有你能看。")
      .addButton((b) => b.setButtonText("在 GitHub 上看").onClick(() => window.open(`https://github.com/${a.owner}/${a.repo}`)));
  }
}
