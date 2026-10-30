/**
 * [INPUT]: 外部注入的 Http(Obsidian 里是 requestUrl，测试里是 fetch)
 * [OUTPUT]: GitHubApi 带登录凭证的 REST 调用；NetError 没网；AuthError 登录失效
 * [POS]: github 的传输层。只管发请求和把错误分成三类，不懂备份是什么
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  headers?: Record<string, string>;
}

/** 电脑和手机都走 Obsidian 的 requestUrl，绕开浏览器跨域限制 */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** 连不上：没网或 GitHub 挂了。状态栏显示「没网 · 联网后自动补上」 */
export class NetError extends Error {}
/** 登录失效(用户在 GitHub 撤销了授权)。要重新登录 */
export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const API = "https://api.github.com";

export class GitHubApi {
  constructor(private http: Http, private token: string) {}

  /** 测试里可以换成不等待 */
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** GitHub 限流(一次备份很多附件时会碰到)：按它说的时间等，最多重试 3 次 */
  async raw(method: string, path: string, body?: unknown, accept = "application/vnd.github+json", extra: Record<string, string> = {}): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.once(method, path, body, accept, extra);
      const h = res.headers ?? {};
      const get = (k: string) => h[k] ?? h[k.toLowerCase()];
      const limited = res.status === 429 || (res.status === 403 && (get("Retry-After") || get("X-RateLimit-Remaining") === "0" || /rate limit/i.test(res.text)));
      if (!limited || attempt >= 3) return res;
      const after = Number(get("Retry-After"));
      const reset = Number(get("X-RateLimit-Reset"));
      const wait = after > 0 ? after * 1000 : reset > 0 ? reset * 1000 - Date.now() : 60_000 * (attempt + 1);
      await this.sleep(Math.min(Math.max(wait, 1000), 15 * 60_000));
    }
  }

  private async once(method: string, path: string, body: unknown, accept: string, extra: Record<string, string>): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await this.http({
        url: path.startsWith("http") ? path : API + path,
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extra,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new NetError(String((e as Error)?.message ?? e));
    }
    if (res.status === 401) throw new AuthError("登录失效了");
    return res;
  }

  /** 2xx 返回 JSON；allow 里的状态码返回 null；其余抛 ApiError。extra 是附加的请求头 */
  async json<T>(method: string, path: string, body?: unknown, allow: number[] = [], extra?: Record<string, string>): Promise<T | null> {
    const res = await this.raw(method, path, body, undefined, extra);
    if (res.status >= 200 && res.status < 300) return (res.text ? JSON.parse(res.text) : null) as T;
    if (allow.includes(res.status)) return null;
    throw new ApiError(res.status, `GitHub ${res.status}: ${res.text.slice(0, 200)}`);
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.raw("GET", path, undefined, "application/vnd.github.raw+json");
    if (res.status !== 200) throw new ApiError(res.status, `GitHub ${res.status}: ${res.text.slice(0, 200)}`);
    return new Uint8Array(res.arrayBuffer);
  }
}
