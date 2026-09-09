# Kernel Build Bot

Telegram 频道成员与序列号白名单双重校验的 GitHub Actions 内核构建机器人。序列号在 SQLite 中仅保存带服务器 pepper 的 HMAC-SHA256，不保存明文；可选绑定 Telegram 用户 ID。

## 功能

- 非频道成员先用 `/join` 提交序列号；白名单验证通过后签发 10 分钟、限 1 人的一次性私密邀请链接。
- 进入频道后必须仍是指定频道成员，且序列号处于启用状态，才显示并触发构建。
- 序列号可绑定 Telegram 用户，防止频道成员借用他人序列号。
- 菜单支持 6.12.23、6.12.38 Ace6T、6.12.38 OnePlus 15T、6.12.58。
- 支持 KernelSU 分支、SUSFS、NoMount、KPM、LZ4/Zstd、LZ4KD、zarm、Unicode、BBR/Brutal、Droidspaces、网络增强、ADIOS、Re-Kernel、基带保护和自用配置。
- SUSFS/NoMount 自动互斥，zarm 强制依赖 LZ4KD；触发前再次检查频道和数据库。
- 管理员命令：`/allow 序列号 [Telegram用户ID]`、`/revoke 序列号`、`/allowed`。
- 管理员可直接上传 UTF-8 `.txt`/`.csv` 白名单；每行格式为 `序列号` 或 `序列号,Telegram用户ID`，最多 5000 条。

## 部署

1. 在 Telegram 客户端创建频道，通过 BotFather 创建机器人。
2. 把机器人加入私密频道并设为管理员，至少授予邀请用户权限；否则无法签发一次性邀请链接或稳定检查成员。
3. Linux/容器部署时，创建只允许读取仓库和运行 Actions 的 GitHub fine-grained PAT；不要使用个人全权限 Token。Windows 本机可设置 `GITHUB_USE_GH_CLI=true` 并留空 `GITHUB_TOKEN`，复用 `gh auth` 的凭据。
4. 复制 `.env.example` 为 `.env`，填写 Bot Token、频道 ID、管理员 Telegram ID、GitHub 凭据，并生成足够长的随机 `SERIAL_PEPPER`。
5. 启动：`docker compose up -d --build`。
6. 管理员私聊机器人执行 `/allow 3B15A800Y5D00000 123456789` 添加首条绑定记录。

Windows 本机没有 Docker 时，可执行 `py -3.12 -m venv .venv`，随后用
`.venv\Scripts\pip install -e .` 安装依赖，填写 `.env` 后运行
`powershell -NoProfile -ExecutionPolicy Bypass -File .\run_windows.ps1`。

`SERIAL_PEPPER` 一旦更换，现有白名单摘要将无法匹配。请备份 `data/bot.db` 和 `.env`，二者都不要提交到 Git。
