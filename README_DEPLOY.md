# 轻课 / LiteCourse 云端托管引擎部署指南 (`course_helper_cloud`)

本服务负责在云端常驻运行多账号雨课堂与学习通的**整点定时自动签到**（免扫码进班 + 全自动定位签到）与**雨课堂 WebSocket 视觉 AI 全自动答题**，让 Android 与 iOS 手机端可以彻底划掉后台甚至关机。

---

## 1. 环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `PORT` | 否 | `8787` | HTTP 监听端口（ClawCloud / Render 会自动注入） |
| `ACCESS_CODE` | **是** | `dev-access-code` | 客户端接入访问口令（**与打包进 Flutter 客户端的内置密钥一致**） |
| `ENCRYPTION_KEY` | **是** | 自动派生 | AES-256-GCM 静态加密主密钥（≥32 字符），用于加密 SQLite 中的 Cookie 与 AI Key |
| `DATA_DIR` | 否 | `/app/data` | SQLite 持久化目录（部署时务必挂载持久化卷） |
| `SEMESTER_START_MONDAY` | 否 | `2026-09-07` | 珠科本学期第 1 周周一日期（全客户端统一周次基准） |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |

> 生成高强度随机密钥（PowerShell）：
> ```powershell
> -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
> ```

---

## 2. 推荐零成本部署方式：ClawCloud Run（新加坡/香港节点，国内直连 + 持久化卷）

1. 将本目录推送到你的**私有 GitHub 仓库**（或在 GitHub Actions 构建镜像推送至 GHCR `ghcr.io/<你的用户名>/course-helper-cloud:latest`）。
2. 登录 [ClawCloud Run](https://run.claw.cloud/)（使用 GitHub 登录享每月 $5 免费额度，单容器 0.2C / 128MB 内存足够常驻一整月）：
   - **Image**：填入你的镜像地址（或通过 Git 仓库部署）；
   - **CPU / Memory**：`0.2 vCPU` / `128 MiB`（实测 Node 24 常驻内存约 45~65 MB）；
   - **Port**：`8787`，勾选开启 **Public Access** 获取免费国内直连 HTTPS 域名；
   - **Environment Variables**：填入 `ACCESS_CODE`、`ENCRYPTION_KEY`、`SEMESTER_START_MONDAY`；
   - **Local Storage / Volume**：挂载 `/app/data`（1 GiB 足够，保证重启容器不丢已同步账号与日志）。
3. 部署成功后浏览器访问 `https://<你的公网域名>/health`，看到：
   ```json
   { "ok": true, "service": "course-helper-cloud", ... }
   ```
   即表示云端引擎运行正常！

---

## 3. 其他部署方式

### Docker Compose（自有 VPS / NAS / 长期开机电脑）
```bash
cp .env.example .env
# 编辑 .env 填入 ACCESS_CODE 和 ENCRYPTION_KEY
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

### Render / Koyeb 等会休眠的免费平台（配合防休眠）
若部署在 15 分钟无请求即休眠的平台，可在你现有的 Cloudflare Worker 中增加一个每 5 分钟触发的 Cron Trigger，定期请求 `https://<你的云端域名>/health` 即可保持常驻。

---

## 4. 安全提示
- 严禁将生产环境的 `ACCESS_CODE` 和 `ENCRYPTION_KEY` 提交至公开仓库；请备份保存在本地 `Software/_secrets_do_not_share/` 目录中。
- 拿到线上 HTTPS 域名与 `ACCESS_CODE` 后，即可进入阶段二，将其内置到轻课 Flutter 客户端（`v1.7.0`）实现所有同学零配置开箱即用。
