/**
 * [INPUT]: Obsidian 的 requestUrl
 * [OUTPUT]: http 给 github 层用的请求函数
 * [POS]: obsidian 层的网络口。requestUrl 不受浏览器跨域限制，电脑和手机都能直连 GitHub
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { requestUrl } from "obsidian";
import type { Http } from "../github/api";

export const http: Http = async (req) => {
  const r = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  let text = "";
  try {
    text = r.text;
  } catch {
    /* 二进制内容没有文本 */
  }
  return { status: r.status, text, arrayBuffer: r.arrayBuffer, headers: r.headers };
};
