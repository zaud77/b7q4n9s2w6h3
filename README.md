# Kernel Build Bot

Telegram 频道成员与序列号白名单双重校验的 GitHub Actions 内核构建机器人。数据库使用带服务器 pepper 的 HMAC-SHA256 查找序列号，同时在本机数据库保存原值供所有者完整查看；可选绑定 Telegram 用户 ID。

## 功能

- 使用 `/joinlink` 生成“需要管理员批准”的申请链接；用户点击后不会直接进入频道，机器人会主动私聊并要求输入设备序列号，通过白名单后才批准加入。
- `/start` 只显示机器人状态；`/join` 可重新进入序列号验证流程。
- 进入频道后必须仍是指定频道成员，且序列号处于启用状态，才显示并触发构建。
- 已绑定 TG 账号的频道成员使用 `/build` 时直接读取有效绑定，不重复要求输入序列号。
- 首次构建时选择并绑定一个构建脚本；后续只显示该脚本的功能菜单，服务端拒绝切换到其他脚本。
- 每个 TG 账号按北京时间自然日最多成功提交 2 次构建，失败的 GitHub 触发不计次数。
- 提交后不向普通用户显示 GitHub 仓库、Actions 地址、构建配置或交付说明；机器人持久化跟踪对应运行，成功后只私聊发送请求的 ZIP 文件，机器人重启后继续跟踪。所有者仍可查看维护信息。
- `/allow` 和白名单文件只登记序列号，不要求 Telegram ID；用户首次通过入频道验证时自动绑定其 Telegram 账号，防止之后被他人借用。
- 菜单支持 6.12.23、6.12.38 Ace6T、6.12.38 OnePlus 15T、6.12.58。
- 支持 KernelSU 分支、SUSFS、NoMount、KPM、LZ4/Zstd、LZ4KD、zarm、Unicode、BBR/Brutal、Droidspaces、网络增强、ADIOS、Re-Kernel和基带保护；自用配置仅所有者可见、可启用。
- SUSFS/NoMount 自动互斥，zarm 强制依赖 LZ4KD；触发前再次检查频道和数据库。
- 只有 `ADMIN_USER_IDS` 中的所有者可使用管理员命令：`/allow 序列号`、`/revoke 序列号`、`/allowed`、`/joinlink`。
- `/allowed` 会分多条消息显示完整白名单，不再只显示尾号或截断前 100 条。
- 管理员可直接上传 UTF-8 `.txt`/`.csv` 白名单；每行格式为 `序列号` 或 `序列号,Telegram用户ID`，最多 5000 条。

## 部署

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
