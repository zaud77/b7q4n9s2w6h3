# Build Workspace

运行入口为 `worker/src/index.ts`，部署到现有 Cloudflare Worker，继续使用原来的 D1、KV、Telegram 机器人和用户绑定数据。本仓库在 `zaominn` 下私有维护，完整保留本地 Git 历史。不会迁移或改写原内核仓库。

## 用户命令

完成序列号绑定和入群验证后，在私聊发送 `/nomount`，确认后构建自己的 NoMount Suite LKM。命令不接受另一个序列号，不要求绑定内核构建脚本，也不修改已有脚本选择或功能记忆。

构建前再次检查当前序列号、白名单启用状态和成员身份。仅把序列号的 SHA256 提交到 `zaominn/nomount-lkm`，不把明文序列号放入新构建的 Actions 输入或任务记录。请求编号用于精确关联构建；重复点击不重复提交。沿用现有成功构建配额及冷却时间。

产物只发送到发起人的私聊。发送前核对设备摘要、测试包标记、单个 `.ko` 和 Android 后端；发送的是可安装的模块 ZIP，不是套了一层的 Actions 下载包。ARM64、Android 16 及以上、Linux 6.12 是当前适配范围，原厂加载与运行效果仍须实机验证。

`/build` 等已有内核命令保留，仍指向原内核仓库；原账号申诉期间不保证这些构建可用。Python 客户端保留原内核构建用途，本次 `/nomount` 由线上 Cloudflare Worker 提供。

## 管理员凭据

新模块使用独立的 `LKM_GITHUB_TOKEN`，不复用原内核仓库的 `GITHUB_TOKEN`。在 GitHub 创建 `zaominn` 的 fine-grained token，只选择 `nomount-lkm`，授予 Actions 读写、Contents 只读；令牌不提交到 Git，也不要发到聊天里。

本机录入：

```powershell
pwsh -File .\tools\set_lkm_token.ps1
```

输入不会显示；脚本确认账号和工作流后，通过标准输入保存到 Cloudflare Secret，不写本地令牌文件。Cloudflare 登录与 GitHub 登录相互独立。

## 检查与部署

```sh
pnpm install --frozen-lockfile
pnpm run check:worker
pnpm run test:worker
pnpm run deploy:worker
```

迁移时不读取或重建用户白名单，不更换 `SERIAL_PEPPER`。新仓库不自动拥有旧仓库的 GitHub Secrets，部署工作流默认关闭；设置仓库 Secret `CLOUDFLARE_API_TOKEN` 和变量 `CLOUDFLARE_DEPLOY_ENABLED=true` 后才自动部署。未配置时使用已有本机 Wrangler 授权部署。
