# 打牌记账

一个用于牌局房间记账、成员协作、战绩统计和历史复盘的微信小程序项目。

项目采用原生微信小程序作为前端，Node.js + Express 提供 HTTP API，
WebSocket 提供房间实时同步，SQLite 负责本地持久化存储。

## 功能特性

- 微信小程序登录与用户资料维护
- 创建房间、加入房间、离开房间与解散房间
- 房间成员实时同步与房间快照推送
- 牌局交易记录录入、分页查询与结算
- 个人历史、时间线和排行榜统计
- 头像上传与静态资源访问
- 房间分享码、小程序码与二维码生成
- 后端 Docker 镜像构建与 GitHub Actions 发布流程

## 技术栈

- 小程序：微信小程序原生 JS / WXML / WXSS
- 后端：Node.js、Express、ws
- 鉴权：JWT
- 数据库：SQLite（better-sqlite3）
- 文件上传：multer
- 二维码：qrcode
- 测试：Node.js 内置 test runner
- 部署：Docker、GitHub Actions

## 目录结构

```text
.
├── poker-ledger/                 # 微信小程序工程
│   └── miniprogram/
│       ├── pages/                # 页面：首页、房间、排行榜、历史等
│       ├── utils/                # 请求、常量、格式化、校验等工具
│       └── app.json              # 小程序页面与窗口配置
├── poker-ledger-server/          # Node.js 后端
│   ├── src/                      # API、鉴权、存储、WebSocket 等逻辑
│   ├── test/                     # Node.js 测试用例
│   ├── data/                     # SQLite 数据与上传文件目录
│   ├── Dockerfile                # 后端镜像构建配置
│   └── package.json
└── .github/workflows/            # CI 与 Docker 镜像发布流程
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm
- 微信开发者工具

### 安装后端依赖

```bash
cd poker-ledger-server
npm ci
```

如果本地没有 lockfile 或需要重新解析依赖，也可以使用：

```bash
npm install
```

### 配置环境变量

后端支持通过环境变量覆盖默认配置。开发环境可在 `poker-ledger-server/.env`
中配置，生产环境应由部署平台注入。

```bash
PORT=3000
JWT_SECRET=请替换为强随机密钥
WECHAT_APPID=微信小程序 AppID
WECHAT_APPSECRET=微信小程序 AppSecret
SQLITE_FILE=./data/db.sqlite
LOG_LEVEL=info
LOG_HTTP_ACCESS=1
```

核心配置说明：

- `PORT`：后端 HTTP 与 WebSocket 服务端口，默认 `3000`
- `JWT_SECRET`：JWT 签名密钥，生产环境必须使用强随机值
- `WECHAT_APPID` / `WECHAT_APPSECRET`：微信登录换取 openid 所需配置
- `SQLITE_FILE`：SQLite 数据库文件路径，默认 `data/db.sqlite`
- `DB_FILE`：旧 JSON 数据路径，仅用于首次迁移或兼容
- `LOG_LEVEL`：日志级别，支持 `debug`、`info`、`warn`、`error`
- `LOG_HTTP_ACCESS`：HTTP 访问日志开关，`1` 开启，`0` 关闭

### 启动后端

```bash
cd poker-ledger-server
npm run dev
```

启动后默认监听：

```text
HTTP API:  http://localhost:3000
WebSocket: ws://localhost:3000/ws
```

### 配置小程序后端地址

小程序接口地址集中在：

```text
poker-ledger/miniprogram/utils/const.js
```

开发或真机调试时，请将 `develop` 环境中的地址改为当前设备可访问的后端地址。
真机调试不能使用 `127.0.0.1`，应使用电脑在局域网中的 IP 或已部署域名。

### 运行小程序

1. 打开微信开发者工具
2. 导入 `poker-ledger/` 目录
3. 确认后端地址配置正确
4. 编译并预览小程序

## 常用命令

```bash
# 后端开发启动
cd poker-ledger-server && npm run dev

# 后端生产启动
cd poker-ledger-server && npm start

# 后端语法检查
cd poker-ledger-server && node --check src/index.js

# 运行全部测试
cd poker-ledger-server && node --test

# 运行单个测试文件
cd poker-ledger-server && node --test test/leaderboard.test.js
```

## API 概览

后端接口统一使用 JSON 响应，业务成功时返回：

```json
{
  "ok": true
}
```

业务失败时返回：

```json
{
  "ok": false,
  "code": "ERROR_CODE",
  "message": "错误说明"
}
```

主要接口分组：

- 鉴权：`/api/auth/wechat`、`/api/auth/deactivate`
- 用户：`/api/me`、`/api/users/profile`
- 房间：`/api/rooms/create`、`/api/rooms/join`、`/api/rooms/my`
- 交易：`/api/txs`、`/api/rooms/:roomCode/txs`
- 历史：`/api/history/timeline`、`/api/history/me`
- 结算：`/api/settlements/:roomCode`
- 分享：`/api/rooms/:roomCode/share-codes`
- 上传：`/api/uploads/avatar`

## WebSocket

WebSocket 连接地址：

```text
ws://<host>/ws?token=<JWT>
```

订阅房间：

```json
{
  "type": "subscribe",
  "roomCode": "XXXXXX"
}
```

服务端推送：

- `room_snapshot`：房间、成员与交易快照
- `room_dissolved`：房间已解散与结算信息
- `error`：错误码与错误信息

## 数据存储

默认数据目录：

```text
poker-ledger-server/data/
├── db.sqlite       # SQLite 数据库
└── uploads/        # 用户头像等上传资源
```

首次启动时，如果检测到旧 JSON 数据文件，后端会尝试迁移到 SQLite。
生产环境请为 `data/` 目录配置持久化存储，避免容器重建导致数据丢失。

## 测试

项目后端使用 Node.js 内置 test runner，无需额外测试框架。

```bash
cd poker-ledger-server
node --test
```

当前测试覆盖重点包括：

- 排行榜统计
- 历史记录查询
- 交易分页

## Docker 部署

后端提供 `Dockerfile`，可构建生产镜像：

```bash
cd poker-ledger-server
docker build -t poker-ledger-server .
```

运行示例：

```bash
docker run -d \
  --name poker-ledger-server \
  -p 3000:3000 \
  -e JWT_SECRET=请替换为强随机密钥 \
  -e WECHAT_APPID=微信小程序 AppID \
  -e WECHAT_APPSECRET=微信小程序 AppSecret \
  -v "$(pwd)/data:/app/data" \
  poker-ledger-server
```

GitHub Actions 已配置后端测试、镜像构建和 Docker Hub 发布流程。

## 安全注意

- 不要提交 `.env`、真实数据库、头像上传文件或任何密钥
- 生产环境必须替换默认 `JWT_SECRET`
- 微信 `AppSecret` 只能放在服务端环境变量中
- 小程序发布前需确认接口域名、WebSocket 域名和微信后台合法域名配置一致
- 数据目录应定期备份，尤其是生产环境的 SQLite 文件

## 贡献方式

1. 基于当前分支创建功能分支
2. 保持 CommonJS、双引号、2 空格缩进和分号风格
3. 新增或调整后端逻辑时补充相应测试
4. 提交前运行 `node --test` 和必要的语法检查

## License

当前仓库未声明开源许可证。公开发布前请先补充明确的 License 文件。
