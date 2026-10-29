/**
 * [INPUT]: Obsidian 的 addIcon
 * [OUTPUT]: registerIcons 注册插件图标(nb-cloud 等)；svgIcon 在任意元素里画一个图标
 * [POS]: ui 的图标库。图形照设计稿：16 格、1.5 线宽、跟随文字颜色
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { addIcon } from "obsidian";

const IC: Record<string, string> = {
  cloud: '<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .5-5.76A4.1 4.1 0 0 0 4.2 6.4 3.05 3.05 0 0 0 4.6 12.5Z"/>',
  cloudOk: '<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .5-5.76A4.1 4.1 0 0 0 4.2 6.4 3.05 3.05 0 0 0 4.6 12.5Z"/><path d="m6.2 9.2 1.4 1.3 2.4-2.8"/>',
  cloudOff: '<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .5-5.76A4.1 4.1 0 0 0 4.2 6.4 3.05 3.05 0 0 0 4.6 12.5Z"/><path d="m2.5 2.5 11 11"/>',
  sync: '<path d="M12.8 6.5A5 5 0 0 0 3.6 5.2M3.2 9.5a5 5 0 0 0 9.2 1.3"/><path d="M3.4 2.6v2.8h2.8M12.6 13.4v-2.8H9.8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 3.6V3a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.6"/>',
  back: '<path d="m10 3-5 5 5 5"/>',
  file: '<path d="M4 2h5.2L12.5 5.3V14H4z"/><path d="M9 2v3.5h3.5"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5.2v.1"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  user: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.5a5.25 5.25 0 0 1 10.5 0"/>',
  chev: '<path d="m6 3 5 5-5 5"/>',
  spark: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z"/>',
  laptop: '<rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7 12.5h2"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.8V8l2.2 1.5"/>',
};

export type IconName = keyof typeof IC;

/** 给 Obsidian 注册的图标(功能区、笔记顶栏用)，画布是 100×100 */
export function registerIcons() {
  for (const n of ["cloud", "cloudOk", "cloudOff", "sync"] as const) {
    addIcon(
      `nb-${n.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`,
      `<g transform="scale(6.25)" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${IC[n]}</g>`,
    );
  }
}

const parser = new DOMParser();

export function svgIcon(parent: HTMLElement, name: IconName, cls = "nb-ico"): SVGElement {
  const doc = parser.parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[name]}</svg>`,
    "image/svg+xml",
  );
  const svg = parent.ownerDocument.importNode(doc.documentElement, true) as unknown as SVGElement;
  svg.setAttribute("class", cls);
  parent.appendChild(svg);
  return svg;
}
