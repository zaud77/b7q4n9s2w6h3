# Build Workspace

运行入口为 `worker/src/index.ts`，部署到现有 Cloudflare Worker，继续使用原来的 D1、KV、Telegram 机器人和用户绑定数据。维护仓库为 `zaud77/q7m4x2p9v6k8`，完整保留本地 Git 历史。

## 用户命令

完成序列号绑定和入群验证后，在私聊发送 `/nomount`，确认后构建自己的 NoMount Suite LKM。命令不接受另一个序列号，不要求绑定内核构建脚本，也不修改已有脚本选择或功能记忆。

构建前再次检查当前序列号、白名单启用状态和成员身份。仅把序列号的 SHA256 提交到 `zaud77/nomount-lkm`，不把明文序列号放入新构建的 Actions 输入或任务记录。请求编号用于精确关联构建；重复点击不重复提交。沿用现有成功构建配额及冷却时间。

产物只发送到发起人的私聊。发送前核对设备摘要、测试包标记、单个 `.ko` 和 Android 后端；发送的是可安装的模块 ZIP，不是套了一层的 Actions 下载包。ARM64、Android 16 及以上、Linux 6.12 是当前适配范围，原厂加载与运行效果仍须实机验证。

`/build` 等已有内核命令使用 `zaud77/t8x3p6r9m2k7`，保留全部十个机型/金紫标工作流、序列号授权、脚本绑定、功能选择记忆和私聊产物交付。Python 客户端默认仓库也同步到新地址；`/nomount` 由线上 Cloudflare Worker 提供。KowSU 管理器仍从独立的 `zaominn/KowSU` 获取，不随构建仓库迁移。

所有用户，包括管理员，每个北京时间自然日共用一次成功构建额度。内核和 `/nomount` 共用额度；失败不扣次数，进行中的任务占用唯一槽位。每天北京时间零点进入新额度，迁移不清空既有成功记录或用户绑定。管理员 `/resetquota` 仍用于处理需要人工补偿的情况。

## 管理员凭据

内核使用独立的 `KERNEL_GITHUB_TOKEN`，NoMount LKM 使用独立的 `LKM_GITHUB_TOKEN`，均不回退到旧账号的 `GITHUB_TOKEN`。在 GitHub 创建 `zaud77` 的 fine-grained token，各自只选择对应仓库，授予 Actions 读写、Contents 只读；令牌不提交到 Git，也不要发到聊天里。

本机录入：

```powershell
pwsh -File .\tools\set_lkm_token.ps1
pwsh -File .\tools\set_lkm_token.ps1 -BuildKind kernel
```

输入不会显示；脚本确认账号和工作流后，通过标准输入保存到 Cloudflare Secret，不写本地令牌文件。Cloudflare 登录与 GitHub 登录相互独立。

迁移账号后需要重新录入两枚令牌，改仓库地址不会扩大旧令牌的权限。`/health` 的 `kernelRepository` 和 `nomountRepository` 应分别为 `zaud77/t8x3p6r9m2k7` 与 `zaud77/nomount-lkm`；两个 `BuildsReady` 字段只表示令牌已设置，不代表 Actions 写权限已验证。既有任务仍关联其提交时的仓库，不把旧仓库的 Actions 运行编号套用到新仓库。

## 检查与部署

```sh
pnpm install --frozen-lockfile
pnpm run check:worker
pnpm run test:worker
pnpm run deploy:worker
```

迁移时不读取或重建用户白名单，不更换 `SERIAL_PEPPER`。新仓库不自动拥有旧仓库的 GitHub Secrets，部署工作流默认关闭；设置仓库 Secret `CLOUDFLARE_API_TOKEN` 和变量 `CLOUDFLARE_DEPLOY_ENABLED=true` 后才自动部署。未配置时使用已有本机 Wrangler 授权部署。
