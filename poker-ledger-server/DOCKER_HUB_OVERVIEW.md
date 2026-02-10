# poker-ledger-server

打牌记账小程序后端服务镜像（Node.js + Express + WebSocket + SQLite）。

## 镜像地址

`docker.io/mine233/poker-ledger-server`

## 标签说明

- `main`：来自 `main` 分支的持续集成构建，适合测试环境
- `latest`：来自 `v*.*.*` 版本标签的最新稳定版本
- `x.y.z` / `x.y`：语义化版本标签（例如 `0.1.0`、`0.1`）
- `sha-<commit>`：按提交哈希生成的可追溯标签

## 快速开始（仅启动后端容器）

1. 拉取镜像

```bash
docker pull mine233/poker-ledger-server:latest
```

2. 准备环境变量文件（示例：`.env.production`）

```env
# 必填：生产环境请使用强随机密钥
JWT_SECRET=replace-with-strong-random-secret

# 必填：微信小程序登录换 openid 依赖该配置
WECHAT_APPID=wx1234567890abcdef
WECHAT_APPSECRET=replace-with-wechat-app-secret

# 可选：默认 3000
PORT=3000

# 可选：默认 /app/data/db.sqlite
SQLITE_FILE=/app/data/db.sqlite

# 可选：日志级别（debug|info|warn|error）
LOG_LEVEL=info

# 可选：1 开启 HTTP 访问日志，0 关闭
LOG_HTTP_ACCESS=1
```

3. 创建并启动容器（含数据持久化）

```bash
docker run -d \
  --name poker-ledger-app \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file ./.env.production \
  -e NODE_ENV=production \
  -v poker_ledger_app_data:/app/data \
  mine233/poker-ledger-server:latest
```

## 域名与 HTTPS（Caddy 反向代理）

说明：镜像本身不包含域名与证书配置。需要 HTTPS 时，请自行创建 `Caddyfile` 并部署 Caddy（或使用 Nginx/Traefik）。

1. DNS 配置

- 将 `api.example.com` 的 A/AAAA 记录指向你的服务器公网 IP

2. 准备 `Caddyfile`（示例）

```caddyfile
{
  # 全局配置
  email admin@example.com  # 用于 Let's Encrypt 证书通知

  # 显式保留 h1，避免部分 iOS 场景下 WebSocket 与 h2/h3 协商异常
  servers {
    protocols h1 h2 h3
  }
}

# 生产域名
api.example.com {
  # Caddy 会自动处理 WebSocket 升级，不手工透传 Upgrade/Connection 头
  reverse_proxy app:3000

  # 访问日志
  log {
    output file /data/access.log
    format json
  }

  # HTTPS 自动配置（Caddy 自动处理）
}

```

3. 使用 Compose 启动（示例）

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

  app:
    image: mine233/poker-ledger-server:latest
    restart: unless-stopped
    env_file:
      - .env.production
    environment:
      - NODE_ENV=production
      - PORT=3000
    volumes:
      - app_data:/app/data
    expose:
      - "3000"

volumes:
  caddy_data:
  caddy_config:
  app_data:
```

## 运行时持久化目录

- `/app/data/db.sqlite`：SQLite 数据库
- `/app/data/uploads/`：上传文件（如头像）

请务必挂载数据卷到 `/app/data`，避免容器重建后数据丢失。

## 常用运维命令

查看日志：

```bash
docker logs -f poker-ledger-app
```

更新镜像并重建容器：

```bash
docker pull mine233/poker-ledger-server:latest
docker rm -f poker-ledger-app
docker run -d \
  --name poker-ledger-app \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file ./.env.production \
  -e NODE_ENV=production \
  -v poker_ledger_app_data:/app/data \
  mine233/poker-ledger-server:latest
```
