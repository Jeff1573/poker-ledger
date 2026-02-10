# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

打牌记账微信小程序（poker-ledger）。用户通过微信登录后创建/加入房间，成员间记录转账交易，系统实时计算净收支，房主解散房间后生成结算快照。

**Monorepo 结构，前后端分离：**
- `poker-ledger/miniprogram/` — 微信小程序原生（JS/WXML/WXSS，CommonJS）
- `poker-ledger-server/` — Node.js 后端（Express + WebSocket + SQLite）

## 构建与运行命令

### 后端（poker-ledger-server/）
```bash
cd poker-ledger-server && npm ci          # 安装依赖
cd poker-ledger-server && npm start       # 启动服务（等同 node src/index.js）
cd poker-ledger-server && node --check src/index.js  # 语法检查（无 ESLint）
```

### 测试（Node 内置 test runner）
```bash
cd poker-ledger-server && node --test                            # 运行所有测试
cd poker-ledger-server && node --test test/txPagination.test.js  # 运行单个文件
cd poker-ledger-server && node --test --test-name-pattern "名称" test/xxx.test.js  # 运行单个用例
```

### 小程序（poker-ledger/）
用微信开发者工具打开 `poker-ledger/` 目录（注意不是 `miniprogram/`）。无自动化 build/lint/test。

## 架构设计

### 后端分层（poker-ledger-server/src/）
- `index.js` — Express 路由定义 + 参数校验 + HTTP 服务启动（所有路由集中在此文件）
- `store.js` — 核心业务逻辑 + 数据访问（SQLite prepared statements + 事务），写操作通过 `withLock` 互斥锁串行化
- `auth.js` — JWT 签发/验证 + `authMiddleware` 中间件
- `wsHub.js` — WebSocket Hub，维护 `roomCode -> Set<WebSocket>` 订阅关系，负责房间内实时广播
- `wechat.js` — 微信 jscode2session API 调用
- `sqlite.js` — better-sqlite3 连接初始化（WAL 模式）
- `sqliteSchema.js` — 数据库 DDL（9 张表 + 6 个索引）
- `config.js` — 环境变量读取（PORT、JWT_SECRET、WECHAT_APPID/APPSECRET）
- `logger.js` — 结构化 JSON 日志

### 数据库（SQLite，better-sqlite3）
核心表：`users`、`rooms`、`room_members`、`room_totals`、`room_txs`、`user_room`（一人一房映射）、`settlements`、`settlement_totals`、`settlement_members`、`meta`。无 ORM，使用原始 SQL prepared statements（全部定义在 `store.js` 的 `stmt` 对象中）。历史上从 JSON 文件迁移到 SQLite，`sqliteImport.js` 为迁移工具。

### 小程序端关键文件
- `app.js` — 全局入口，管理登录态（`ensureSession`）、提供 `apiCall` 统一网络请求（自动处理 401 重登）
- `utils/const.js` — 所有后端地址（`API_BASE_URL`、`WS_BASE_URL`）和业务常量集中定义
- `utils/api.js` — wx.request 封装
- `pages/home/` — 首页，创建/加入房间，处理分享卡片落地
- `pages/room/` — 核心交互页，WebSocket 实时通信 + 指数退避重连
- `pages/profile/` — 用户资料设置
- `pages/settlement/` — 结算详情

### 认证链路
小程序 `wx.login()` → POST `/api/auth/wechat`（code 换 openId）→ 后端调微信 API 获取 openId → 签发 JWT（7天有效期）→ 后续请求 `Authorization: Bearer <token>` → 401 时自动重登重试。WebSocket 通过 URL query `?token=JWT` 鉴权。

### WebSocket 协议
- 连接：`wss://host/ws?token=JWT`
- 客户端发送：`{ type: "subscribe", roomCode }` 订阅房间
- 服务端推送：`room_snapshot`（完整快照）、`tx_added`（增量交易）、`room_dissolved`（解散通知）、`error`

### API 返回约定
- 成功：`{ ok: true, ...data }`
- 业务失败：HTTP 200 + `{ ok: false, code: "ERROR_CODE", message: "提示" }`
- 鉴权失败：HTTP 401 + `{ ok: false, code: "UNAUTHORIZED" }`

## 代码风格

- **语言**：纯 JavaScript + CommonJS（`require`/`module.exports`），不引入 ESM 或 TypeScript
- **格式**：2 空格缩进、双引号、保留分号
- **注释与文案**：简体中文
- **命名**：变量/函数 camelCase、常量 UPPER_SNAKE_CASE、文件名 lowerCamel 或全小写、错误码全大写下划线、小程序事件 `handle` 前缀、私有字段 `_` 前缀
- **require 分组**：Node 内置 → 第三方 → 本地模块，组间空一行
- **变更粒度**：只改与需求相关的行，不顺手全文件格式化

## 部署

Docker Compose（Caddy 反代 + Node 应用），配置见 `poker-ledger-server/Dockerfile`、`docker-compose.yml`、`Caddyfile.example`。生产域名 `poker.mdice.top`。

## 详细 Agent 规范

参见项目根目录 `AGENTS.md`，包含更详细的后端开发约定、并发数据一致性、WebSocket 协议细节、小程序开发约定等。
