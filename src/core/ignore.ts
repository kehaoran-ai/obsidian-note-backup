/**
 * [INPUT]: 笔记库根目录 .gitignore 的文本
 * [OUTPUT]: makeIgnore 生成「这篇要不要跳过」的判定；ALWAYS 不论 .gitignore 怎么写都不上传的规则
 * [POS]: core 的过滤层。engine 对本地、云端、上次认可三份同时过滤，规则变了也不会误删
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 放密钥的文件夹，永远不上传，.gitignore 里的 ! 也放不开 */
export const ALWAYS = ["**/敏感信息/", "**/sensitive/", "**/secrets/", "**/*.env", "**/.env*"];

interface Rule {
  re: RegExp;
  negate: boolean;
}

function globToRe(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        /* 「**\/」任意层文件夹；结尾的「**」任意内容 */
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function compile(line: string): Rule | null {
  let p = line.replace(/\s+$/, "");
  if (!p || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  /* 中间带「/」的从根目录算起；不带的哪一层都算 */
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const body = globToRe(p);
  const head = anchored ? "^" : "^(?:.*/)?";
  /* 文件夹规则要求后面还有内容(命中的是文件夹里的文件) */
  const tail = dirOnly ? "/.+$" : "(?:/.+)?$";
  return { re: new RegExp(head + body + tail, "u"), negate };
}

/** 照 .gitignore 的常用写法判定；最后一条命中的规则说了算 */
export function makeIgnore(gitignore: string): (path: string) => boolean {
  const always = ALWAYS.map(compile).filter((r): r is Rule => !!r);
  const rules = gitignore.split(/\r?\n/).map(compile).filter((r): r is Rule => !!r);
  return (path: string) => {
    if (always.some((r) => r.re.test(path))) return true;
    let hit = false;
    for (const r of rules) if (r.re.test(path)) hit = !r.negate;
    return hit;
  };
}
