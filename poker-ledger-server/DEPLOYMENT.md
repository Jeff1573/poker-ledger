# Docker 部署使用说明

本文档介绍如何使用 Docker Compose 部署 poker-ledger-server 项目。

## 📦 部署架构

```
┌─────────────────┐
│   Internet      │
└────────┬────────┘
         │ HTTPS (443)
         ↓
┌─────────────────┐
│  Caddy Proxy    │ ← 自动 HTTPS 证书管理
│  (反向代理)      │
└────────┬────────┘
         │ HTTP (3000)
         ↓
┌─────────────────┐
│  App Server     │
│  (Node.js)      │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Volume         │
│  - db.sqlite    │
│  - uploads/     │
└─────────────────┘
```

## 🚀 快速开始

### 前置要求

- 已安装 Docker 和 Docker Compose
- 拥有一个域名,并将 A 记录指向服务器 IP
- 服务器防火墙开放 80 和 443 端口

### 部署步骤

#### 1. 配置域名和证书邮箱

编辑 `Caddyfile` 文件:

```bash
{
    # 修改为你的邮箱(用于 Let's Encrypt 证书通知)
    email your-email@example.com
}

# 修改为你的实际域名
your-domain.com {
    reverse_proxy app:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    log {
        output file /data/access.log
        format json
    }
}
```

#### 2. 配置生产环境变量

编辑 `.env.production` 文件:

```bash
# 微信小程序配置(保持不变)
WECHAT_APPID=wx280d8bf2a2f16fc5
WECHAT_APPSECRET=75a4b77fb4e17f2aab92fb5864670839

# JWT 密钥(必须修改为强随机值)
JWT_SECRET=请替换为下面生成的随机密钥

# 其他配置(保持默认值即可)
PORT=3000
SQLITE_FILE=/app/data/db.sqlite
```

**生成强随机 JWT 密钥:**

```bash
# Linux/macOS
openssl rand -base64 32

# 或使用 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

将生成的密钥复制到 `JWT_SECRET` 配置项。

#### 3. 构建并启动服务

```bash
# 进入项目目录
cd poker-ledger-server

# 构建镜像
docker-compose build

# 启动服务(后台运行)
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看实时日志
docker-compose logs -f
```

#### 4. 验证部署

1. 访问 `https://your-domain.com` 验证 HTTPS 证书
2. 检查应用是否正常响应
3. 使用微信小程序测试连接

## 🔧 运维管理

### 查看服务状态

```bash
# 查看所有容器状态
docker-compose ps

# 查看应用日志
docker-compose logs app

# 查看 Caddy 日志
docker-compose logs caddy

# 实时跟踪日志
docker-compose logs -f app
```

### 重启服务

```bash
# 重启所有服务
docker-compose restart

# 重启单个服务
docker-compose restart app
docker-compose restart caddy
```

### 停止服务

```bash
# 停止服务(保留容器)
docker-compose stop

# 停止并删除容器(保留数据卷)
docker-compose down

# 停止并删除容器和数据卷(⚠️ 数据将丢失)
docker-compose down -v
```

### 更新应用

当代码更新后:

```bash
# 拉取最新代码
git pull

# 重新构建应用镜像
docker-compose build app

# 重启应用容器
docker-compose up -d app

# 查看日志确认启动成功
docker-compose logs -f app
```

### 查看资源使用

```bash
# 查看容器资源占用
docker stats

# 查看磁盘使用
docker system df

# 查看数据卷
docker volume ls
```

## 💾 数据备份与恢复

### 备份应用数据

应用数据(数据库和上传文件)存储在 `app_data` Volume 中。

```bash
# 创建备份目录
mkdir -p backups

# 备份应用数据
docker run --rm \
  -v poker-ledger-server_app_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/app-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

### 备份 HTTPS 证书

证书存储在 `caddy_data` Volume 中。

```bash
# 备份 Caddy 证书
docker run --rm \
  -v poker-ledger-server_caddy_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/caddy-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

### 恢复数据

```bash
# 恢复应用数据
docker run --rm \
  -v poker-ledger-server_app_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/app-data-20240101-120000.tar.gz -C /data

# 恢复后重启应用
docker-compose restart app
```

### 自动备份脚本

创建 `backup.sh`:

```bash
#!/bin/bash

BACKUP_DIR="$(pwd)/backups"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# 备份应用数据
docker run --rm \
  -v poker-ledger-server_app_data:/data \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf /backup/app-data-$DATE.tar.gz -C /data .

# 备份 Caddy 证书(每周一次即可)
if [ $(date +%u) -eq 1 ]; then
  docker run --rm \
    -v poker-ledger-server_caddy_data:/data \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf /backup/caddy-data-$DATE.tar.gz -C /data .
fi

# 删除 30 天前的备份
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete

echo "备份完成: $DATE"
```

添加执行权限并设置定时任务:

```bash
chmod +x backup.sh

# 添加到 crontab (每天凌晨 2 点执行)
crontab -e
# 添加以下行:
# 0 2 * * * /path/to/poker-ledger-server/backup.sh >> /var/log/poker-backup.log 2>&1
```

## 🔒 安全配置

### 1. 环境变量安全

确保 `.env.production` 不被提交到代码仓库:

```bash
# 检查 .gitignore
grep -q ".env.production" .gitignore || echo ".env.production" >> .gitignore

# 验证文件未被跟踪
git status
```

### 2. 防火墙配置

使用 UFW (Ubuntu):

```bash
# 允许 SSH
sudo ufw allow ssh

# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 启用防火墙
sudo ufw enable

# 查看规则
sudo ufw status
```

### 3. 定期更新

```bash
# 更新基础镜像
docker-compose pull

# 重新构建和启动
docker-compose up -d --build

# 清理旧镜像
docker image prune -a
```

### 4. 日志管理

配置 Docker 日志轮转,防止日志占满磁盘:

创建或编辑 `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

重启 Docker:

```bash
sudo systemctl restart docker
docker-compose up -d
```

## 🐛 故障排查

### 容器无法启动

```bash
# 查看容器日志
docker-compose logs app
docker-compose logs caddy

# 检查配置文件语法
docker-compose config
```

### HTTPS 证书获取失败

常见原因:
1. 域名 DNS 未正确解析到服务器 IP
2. 防火墙未开放 80/443 端口
3. 邮箱地址配置错误

排查步骤:

```bash
# 检查域名解析
nslookup your-domain.com

# 检查端口是否开放
netstat -tlnp | grep -E ':(80|443)'

# 查看 Caddy 详细日志
docker-compose logs caddy | grep -i error
```

### 应用连接数据库失败

```bash
# 检查数据卷是否正常挂载
docker volume inspect poker-ledger-server_app_data

# 进入容器检查
docker exec -it poker-ledger-app sh
ls -la /app/data
```

### WebSocket 连接失败

检查 Caddyfile 配置是否包含正确的 header 转发:

```
reverse_proxy app:3000 {
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
}
```

## 📊 监控建议

### 1. 容器健康检查

在 `docker-compose.yml` 中添加健康检查:

```yaml
services:
  app:
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### 2. 磁盘空间监控

```bash
# 检查数据卷大小
docker system df -v

# 检查备份目录大小
du -sh backups/
```

### 3. 日志监控

```bash
# 监控错误日志
docker-compose logs -f app | grep -i error

# 查看 Caddy 访问日志
docker exec poker-ledger-caddy cat /data/access.log | tail -n 100
```

## 📝 配置文件说明

### docker-compose.yml

| 配置项 | 说明 |
|--------|------|
| `caddy.ports` | 映射 80/443 端口到主机 |
| `caddy.volumes` | 挂载 Caddyfile 和证书存储卷 |
| `app.env_file` | 从 .env.production 加载环境变量 |
| `app.volumes` | 挂载数据持久化卷 |
| `networks` | 内部网络隔离 |

### Dockerfile

| 阶段 | 说明 |
|------|------|
| `deps` | 安装生产依赖,编译 better-sqlite3 |
| `production` | 复制依赖和代码,创建非 root 用户 |

### .env.production

| 变量 | 说明 | 必须修改 |
|------|------|----------|
| `WECHAT_APPID` | 微信小程序 AppID | ❌ |
| `WECHAT_APPSECRET` | 微信小程序密钥 | ❌ |
| `JWT_SECRET` | JWT 签名密钥 | ✅ |
| `PORT` | 应用端口 | ❌ |
| `SQLITE_FILE` | 数据库文件路径 | ❌ |

## 🆘 获取帮助

如遇到问题:

1. 查看日志: `docker-compose logs -f`
2. 检查容器状态: `docker-compose ps`
3. 验证配置: `docker-compose config`
4. 查阅 Caddy 文档: https://caddyserver.com/docs/

## 📄 许可证

本项目基于原项目许可证发布。
