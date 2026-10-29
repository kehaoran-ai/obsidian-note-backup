/**
 * [INPUT]: api 的 Http
 * [OUTPUT]: requestCode 向 GitHub 要一串码；waitForToken 等用户在 GitHub 点授权；whoami 账号名
 * [POS]: github 的登录层。用 GitHub 设备码登录：不搭服务器，密码只在 GitHub 上输，插件拿不到
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Http } from "./api";
import { GitHubApi, NetError } from "./api";

/**
 * GitHub OAuth App 的 Client ID(公开值，不是密钥)。
 * 登记在 GitHub 上的「笔记备份」OAuth App(开了 Device Flow，凭证不过期)，老板 2026-10-29 建。
 */
export const CLIENT_ID = "Ov23liWaAGGcRFIBsG4i";
export const clientIdReady = () => !CLIENT_ID.startsWith("REPLACE_");

/** 只要 repo：建私有备份、读写备份 */
const SCOPE = "repo";
export const SIGNUP_URL = "https://github.com/signup?return_to=%2Flogin%2Fdevice";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function post(http: Http, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await http({ url, method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new NetError(String((e as Error)?.message ?? e));
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`GitHub 返回了看不懂的内容(${res.status})`);
  }
}

export async function requestCode(http: Http, clientId = CLIENT_ID): Promise<DeviceCode> {
  const r = await post(http, "https://github.com/login/device/code", { client_id: clientId, scope: SCOPE });
  if (typeof r.user_code !== "string") throw new Error(`GitHub 没给码：${String(r.error_description ?? r.error ?? "未知原因")}`);
  return r as unknown as DeviceCode;
}

export type TokenResult = { token: string } | { expired: true } | { denied: true };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

/** 按 GitHub 要求的间隔轮询，直到用户点了授权、点了取消或码过期 */
export async function waitForToken(http: Http, code: DeviceCode, signal?: AbortSignal, clientId = CLIENT_ID): Promise<TokenResult> {
  let interval = Math.max(5, code.interval) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
    let r: Record<string, unknown>;
    try {
      r = await post(http, "https://github.com/login/oauth/access_token", {
        client_id: clientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch (e) {
      /* 等授权时网络抖一下，接着等 */
      if (e instanceof NetError) continue;
      throw e;
    }
    if (typeof r.access_token === "string") return { token: r.access_token };
    if (r.error === "authorization_pending") continue;
    if (r.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (r.error === "expired_token") return { expired: true };
    if (r.error === "access_denied") return { denied: true };
    throw new Error(`登录没成功：${String(r.error_description ?? r.error)}`);
  }
  return { expired: true };
}

export async function whoami(api: GitHubApi): Promise<string> {
  const u = await api.json<{ login: string }>("GET", "/user");
  return (u as { login: string }).login;
}
