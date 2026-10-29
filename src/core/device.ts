/**
 * [INPUT]: 电脑的主机名
 * [OUTPUT]: cleanHost 把主机名洗成人能认的设备名
 * [POS]: core 的小工具。同步记录、历史版本里用设备名分清是哪台改的
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 「haorandeMacBook-Pro.local」(中文系统「haoran的MacBook Pro」)、「Haorans-MacBook-Air」→「MacBook Pro」「MacBook Air」 */
export function cleanHost(name: string): string {
  const n = name.replace(/\.local$/, "").replace(/[-_]+/g, " ").trim();
  const mac = n.match(/(?:^|de ?|'s |s |的)((?:MacBook|iMac|Mac mini|Mac Studio|Mac Pro)\b.*)$/i);
  return (mac ? mac[1] : n) || "这台电脑";
}
