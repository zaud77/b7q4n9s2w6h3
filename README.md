# Kernel Build Bot

Telegram 频道成员与序列号白名单双重校验的 GitHub Actions 内核构建机器人。序列号在 SQLite 中仅保存带服务器 pepper 的 HMAC-SHA256，不保存明文；可选绑定 Telegram 用户 ID。

## 功能

- 必须仍是指定频道成员，且序列号处于启用状态，才显示并触发构建。
- 序列号可绑定 Telegram 用户，防止频道成员借用他人序列号。
- 菜单支持 6.12.23、6.12.38 Ace6T、6.12.38 OnePlus 15T、6.12.58。
- 支持 KernelSU 分支、SUSFS、NoMount、KPM、LZ4/Zstd、LZ4KD、zarm、Unicode、BBR/Brutal、Droidspaces、网络增强、ADIOS、Re-Kernel、基带保护和自用配置。
- SUSFS/NoMount 自动互斥，zarm 强制依赖 LZ4KD；触发前再次检查频道和数据库。
- 管理员命令：`/allow 序列号 [Telegram用户ID]`、`/revoke 序列号`、`/allowed`。

## 部署

1. 在 Telegram 客户端创建频道，通过 BotFather 创建机器人。
2. 把机器人加入频道并设为管理员，否则 `getChatMember` 不能稳定检查所有成员。
3. 创建只允许读取仓库和运行 Actions 的 GitHub fine-grained PAT；不要使用个人全权限 Token。
4. 复制 `.env.example` 为 `.env`，填写 Bot Token、频道 ID、管理员 Telegram ID、GitHub Token，并生成足够长的随机 `SERIAL_PEPPER`。
5. 启动：`docker compose up -d --build`。
6. 管理员私聊机器人执行 `/allow 3B15A800Y5D00000 123456789` 添加首条绑定记录。

`SERIAL_PEPPER` 一旦更换，现有白名单摘要将无法匹配。请备份 `data/bot.db` 和 `.env`，二者都不要提交到 Git。

