# Kernel Build Bot

Telegram 频道成员与序列号白名单双重校验的 GitHub Actions 内核构建机器人。数据库使用带服务器 pepper 的 HMAC-SHA256 查找序列号，同时在本机数据库保存原值供所有者完整查看；可选绑定 Telegram 用户 ID。

生产环境现已运行在 Cloudflare Workers：Telegram 使用 webhook 调用 Worker，序列号白名单存放在 Workers KV，绑定、会话和构建状态存放在 D1，实际内核编译继续由 GitHub Actions 完成。电脑关机不会影响机器人。

## 功能

- `/start` 和 `/join` 是公开入口：先检查群组成员身份，再检查序列号绑定；未绑定账号只能看到并使用这两个命令。
- 已是群组成员但未绑定序列号时，`/start` 会要求输入序列号并完成绑定；已绑定账号则显示正常功能入口。
- 非群组成员先验证序列号，验证通过后获得需审批的入群链接；验证失败会拒绝本次入群申请。
- 进入群组后必须仍是指定群组成员，且序列号处于启用状态，才显示并触发构建。
- 已绑定 TG 账号的群组成员使用 `/build` 时直接读取有效绑定，不重复要求输入序列号。
- 首次构建时选择并绑定一个构建脚本；后续只显示该脚本的功能菜单，服务端拒绝切换到其他脚本。
- 每个 TG 账号按北京时间自然日最多成功提交 2 次构建，失败的 GitHub 触发不计次数。
- 提交后不向普通用户显示 GitHub 仓库、Actions 地址、构建配置或交付说明；机器人持久化跟踪对应运行，成功后只私聊发送请求的 ZIP 文件，机器人重启后继续跟踪。所有者仍可查看维护信息。
- `/allow` 和白名单文件只登记序列号，不要求 Telegram ID；用户首次通过入频道验证时自动绑定其 Telegram 账号，防止之后被他人借用。
- 菜单按机型排序：6.12.23 一加 15 金标/紫标风驰、6.12.38 一加 15T 金标/紫标风驰、6.12.38 Ace6T、6.12.58。
- 支持 KernelSU 分支、SUSFS、NoMount、KPM、LZ4/Zstd、LZ4KD、zarm、Unicode、BBR/Brutal、Droidspaces、网络增强、ADIOS、Re-Kernel和基带保护；自用配置仅 6.12.23 一加 15 入口可用，且仅所有者可见。
- SUSFS/NoMount 自动互斥，zarm 强制依赖 LZ4KD；触发前再次检查频道和数据库。
- 只有 `ADMIN_USER_IDS` 中的所有者可使用管理员命令：`/allow 序列号`、`/revoke 序列号`、`/allowed`、`/joinlink`。
- `/allowed` 会分多条消息显示完整白名单，不再只显示尾号或截断前 100 条。
- 管理员可直接上传 UTF-8 `.txt`/`.csv` 白名单；每行格式为 `序列号` 或 `序列号,Telegram用户ID`，最多 5000 条。

## 部署

### Cloudflare Workers（生产）

1. 安装依赖：`pnpm install`。
2. 创建 KV 和 D1，并把资源 ID 填入 `worker/wrangler.jsonc`。
3. 执行 `worker/schema.sql` 初始化 D1。
4. 使用 `wrangler secret put` 配置 `TELEGRAM_BOT_TOKEN`、`GITHUB_TOKEN`、`SERIAL_PEPPER` 和 `WEBHOOK_SECRET`。
5. 执行 `pnpm run check:worker` 和 `pnpm run deploy:worker`。
6. 将 Telegram webhook 指向 `/telegram/<WEBHOOK_SECRET>`，并同时设置同值的 `secret_token` 请求头校验。必须订阅 `message`、`callback_query` 和 `chat_join_request`；部署后访问 `/setup-webhook/<WEBHOOK_SECRET>` 可自动修正。

当前生产入口为 `https://gki.zaomin.dpdns.org`，健康检查路径为 `/health`。`worker/migrate_from_sqlite.py` 可把旧版 `data/bot.db` 中的白名单、绑定和构建历史迁移到 KV/D1；迁移期间不要同时接受新的构建请求。

### Python 长轮询版（备用）

1. 在 Telegram 客户端创建频道，通过 BotFather 创建机器人。
2. 把机器人加入私密频道并设为管理员，至少授予邀请用户权限；否则无法接收、批准加入请求或稳定检查成员。
3. Linux/容器部署时，创建只允许读取仓库和运行 Actions 的 GitHub fine-grained PAT；不要使用个人全权限 Token。Windows 本机可设置 `GITHUB_USE_GH_CLI=true` 并留空 `GITHUB_TOKEN`，复用 `gh auth` 的凭据。
4. 复制 `.env.example` 为 `.env`，填写 Bot Token、频道 ID、管理员 Telegram ID、GitHub 凭据，并生成足够长的随机 `SERIAL_PEPPER`。
5. 启动：`docker compose up -d --build`。
6. 管理员私聊机器人执行 `/allow 3B15A800Y5D00000 123456789` 添加首条绑定记录。

Windows 本机没有 Docker 时，可执行 `py -3.12 -m venv .venv`，随后用
`.venv\Scripts\pip install -e .` 安装依赖，填写 `.env` 后运行
`powershell -NoProfile -ExecutionPolicy Bypass -File .\run_windows.ps1`。

`SERIAL_PEPPER` 一旦更换，现有白名单摘要将无法匹配。请备份 `data/bot.db` 和 `.env`，二者都不要提交到 Git。
