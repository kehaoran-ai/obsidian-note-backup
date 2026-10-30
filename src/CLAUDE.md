# src/
> L2 | 父级: ../CLAUDE.md

成员清单
main.ts: 插件入口与总调度，暂停/继续(暂停记在设置里，重启也不自己开始)，读 .git/config、关 Obsidian Git，存取 state.json/log.json，连上/退出，改完 10 秒自动备份、每 60 秒看一眼云端，状态优先级 在跑>两边都改了>没网>出错>好了
core/types.ts: 全部数据形状契约，LocalStore/RemoteStore/SyncState/LogCommit/Clash/Skip
core/bytes.ts: git blob sha1 内容指纹(WebCrypto)、文本判定(保留 BOM)、base64
core/merge.ts: regions3 三方分区，merge3 冲突第 1、2 层，mergeBlocks/assemble 第 3 层合并页，wordMarks 字词高亮，pseudoBase 无旧版时的旧版
core/summary.ts: 改动一句话文案「+ 一行」「旧 → 新」「改了 N 处」
core/log.ts: 备份说明里的元数据编解码(谁、设备、每篇改了什么、修改时间)，SyncLog 增量拉取与按篇查版本
core/ignore.ts: 按笔记库根目录 .gitignore 跳过，敏感信息/sensitive/secrets/.env 永远不上传
core/engine.ts: 同步引擎，大批分段提交(300 篇一段，每段存进度，可暂停、断了接着传)，本地/云端/上次认可三份指纹比对，并发读写，我和 AI 拆两条备份，抢先备份时重来；同一笔记库同一时间只跑一轮(队挂在 globalThis，插件重载也排队)，读到比上次推上去还旧的分支头整轮不写，写回前直读磁盘核对指纹、对不上留到下一轮，两种跳过都记进 state.skips
github/api.ts: 带凭证的 REST 调用，限流按 Retry-After 等待重试 3 次，错误分成 NetError 没网 / AuthError 登录失效 / ApiError
github/auth.ts: GitHub 设备码登录，CLIENT_ID 是老板登记的「笔记备份」OAuth App，码过期自动换新
github/existing.ts: 读笔记库 .git/config 里 origin 的 GitHub 地址，私有且能写才接着用；在组织里读不到算被挡，给批准页入口
github/remote.ts: GitHubRemote 读写云端(读分支头带 no-cache，GitHub 读接口缓存 60 秒；isBehind 用 compare 判断读到的分支头是不是旧的；建树内联文本，一次最多 200 篇；写内容先放 20 次再每 800 毫秒一次，避开限流；请求之间可暂停)，openBackup 找到或新建私有备份，公开仓库拒绝
obsidian/http.ts: requestUrl 包成 Http，绕开跨域
obsidian/vault-store.ts: 笔记库读写，peek 经 adapter 直读磁盘(TFile.stat 是缓存，外部刚写完时是旧的)，删除进回收站
obsidian/who.ts: 我/AI 判定，编辑器里打字算我，编辑器外改的算 AI，手机都算我
ui/icons.ts: 设计稿图标，注册 nb-cloud 等给功能区和顶栏
ui/kit.ts: 时间说法、篇名、状态点、标签、按钮、提示条，只用 textContent
ui/status.ts: 第 2 屏，电脑状态栏+小卡(在跑时可暂停，暂停后继续)，手机顶栏云朵+底部卡片
ui/login.ts: 第 1 屏，有没有账号→带着注册→填码→已连上/找到你的备份/找到你已有的备份(接上后关掉 Obsidian Git)
ui/log-view.ts: 第 3 屏左，同步记录，按天按篇，两条线分我和 AI；分组按筛选缓存，一次只画 40 张卡、滚动接着画，记录没变时只改状态不重画
ui/history-view.ts: 第 3 屏右，历史版本(按天分组，一行写几点和改了什么，别的设备才带设备名)，和现在不一样的行灰底，恢复可撤销
ui/merge-view.ts: 第 4 屏，电脑左右两栏，手机一次一处，选完或「不用选」才清黄点
ui/settings.ts: 设置页，账号、设备名、立即备份

法则: 成员完整·一行一文件·父级链接·技术词前置
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
