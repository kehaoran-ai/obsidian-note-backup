/**
 * [INPUT]: WebCrypto(电脑和手机的 Obsidian 都有)
 * [OUTPUT]: gitBlobSha 内容指纹、asText 文本判定、utf8 / base64 编解码
 * [POS]: core 的字节工具，engine 和 github 共用；指纹和 GitHub 算法一致，本地不用问云端就能比对
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const enc = new TextEncoder();
/* ignoreBOM: 保留开头的 BOM，解码再编码能逐字节还原，指纹才对得上 */
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const utf8 = (s: string): Uint8Array => enc.encode(s);

/** 是文本就返回字符串，二进制(图片、PDF、带 NUL 的)返回 null */
export function asText(data: Uint8Array): string | null {
  if (data.indexOf(0) !== -1) return null;
  try {
    return dec.decode(data);
  } catch {
    return null;
  }
}

/** 和 `git hash-object` 一样：sha1("blob <长度>\0<内容>") */
export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const head = enc.encode(`blob ${data.byteLength}\0`);
  const buf = new Uint8Array(head.byteLength + data.byteLength);
  buf.set(head, 0);
  buf.set(data, head.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(data: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < data.length; i += step) s += String.fromCharCode(...data.subarray(i, i + step));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
