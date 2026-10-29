/**
 * [INPUT]: 笔记库里 .git/config 的文本，api 的 GitHubApi
 * [OUTPUT]: parseGitRemote 从 .git/config 读出 GitHub 上的 owner/repo；findExisting 判定它能不能接着用：能用 / 被组织挡住 / 不算
 * [POS]: github 的「认出已有备份」。用户原来用 Obsidian Git 之类同步过的，接着用他原来的仓库，不另建；仓库在组织里被挡住时明说并给批准入口(老板 2026-10-29 拍板)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { GitHubApi } from "./api";
import { CLIENT_ID } from "./auth";
import { GitHubRemote } from "./remote";

/** 只认 origin 指向 github.com 的；地址里夹着的账号密码一律不读 */
export function parseGitRemote(config: string): { owner: string; repo: string } | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      inOrigin = /^remote\s+"origin"$/.test(sec[1]);
      continue;
    }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+)$/);
    if (!m) continue;
    const url = m[1].trim();
    const hit =
      url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
      url.match(/^[^@/]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return hit ? { owner: hit[1], repo: hit[2] } : null;
  }
  return null;
}

/** 用户在这里给组织批准(Grant)或申请(Request)「笔记备份」的访问 */
export const APPROVE_URL = `https://github.com/settings/connections/applications/${CLIENT_ID}`;

export type Existing =
  | { kind: "ok"; remote: GitHubRemote; full: string }
  /** 仓库在组织里，组织还没批准「笔记备份」，读不到 */
  | { kind: "blocked"; org: string; full: string };

/**
 * 仓库在、私有、当前账号能写：接着用。
 * 读不到但主人是组织：多半是组织没批准第三方应用(GitHub 组织默认挡着)，明说，给批准入口。
 * 其余(公开、只读、个人账号下读不到、不是 GitHub)：当作没有，走新建。
 */
export async function findExisting(api: GitHubApi, config: string | null): Promise<Existing | null> {
  const r = config ? parseGitRemote(config) : null;
  if (!r) return null;
  const full = `${r.owner}/${r.repo}`;
  const res = await api.raw("GET", `/repos/${full}`);
  if (res.status === 403 && /OAuth App access restrictions|organization has enabled/i.test(res.text)) return { kind: "blocked", org: r.owner, full };
  if (res.status === 404 || res.status === 403) {
    /* 组织里的私有仓库被挡时 GitHub 有时直接回 404；主人是组织就当被挡 */
    const owner = await api.json<{ type: string }>("GET", `/users/${r.owner}`, undefined, [404]);
    return owner?.type === "Organization" ? { kind: "blocked", org: r.owner, full } : null;
  }
  if (res.status !== 200) return null;
  const repo = JSON.parse(res.text) as { full_name: string; default_branch: string; private: boolean; permissions?: { push?: boolean } };
  if (!repo.private || !repo.permissions?.push) return null;
  const [owner, name] = repo.full_name.split("/");
  const remote = new GitHubRemote(api, owner, name, repo.default_branch || "main");
  if (!(await remote.head())) await remote.init();
  return { kind: "ok", remote, full: repo.full_name };
}
