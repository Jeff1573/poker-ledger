# AGENTS.md

> 面向：在本仓库执行任务的自动化/半自动化 Coding Agent
> 目标：保持现有实现风格（CommonJS + 轻依赖），用最小改动交付可运行的「小程序 + Node 后端」

## 项目概览
- 小程序：`poker-ledger/miniprogram/`（微信小程序原生：JS/WXML/WXSS）
- 后端：`poker-ledger-server/`（Node.js + Express + WebSocket(ws)）
- 数据：`poker-ledger-server/data/db.json`（JSON 持久化）
- 上传：`poker-ledger-server/data/uploads/`（头像等静态资源）

## 必备环境
- Node.js：建议 `>= 18`（`poker-ledger-server/src/wechat.js` 使用全局 `fetch`）
- 微信开发者工具：用于运行/预览小程序

## Build / Lint / Test 命令

### 后端（poker-ledger-server）
- 安装依赖（推荐可复现）：`cd poker-ledger-server && npm ci`
- 安装依赖（普通）：`cd poker-ledger-server && npm install`
- 启动（开发）：`cd poker-ledger-server && npm run dev`
- 启动（生产）：`cd poker-ledger-server && npm start`
- 直接启动：`cd poker-ledger-server && node src/index.js`
- 语法检查（临时替代 lint）：`cd poker-ledger-server && node --check src/index.js`
- 现状：无 ESLint/Prettier，无 `lint/test` scripts（见 `poker-ledger-server/package.json`）

### 小程序（poker-ledger/miniprogram）
- 运行：用微信开发者工具打开 `poker-ledger/`（不是 `miniprogram/`）
- 页面入口：`poker-ledger/miniprogram/app.json`
- 后端地址：`poker-ledger/miniprogram/utils/const.js`（`API_BASE_URL`/`WS_BASE_URL`）
- 现状：无自动化 build/lint/test；主要依赖开发者工具预览与真机调试

### 测试（推荐：Node 内置 test runner，零依赖）
- 现状：仓库未集成自动化测试框架（无 Jest/Vitest/Mocha 配置）
- 建议目录：`poker-ledger-server/test/**/*.test.js`
- 运行所有测试：`cd poker-ledger-server && node --test`
- 运行单个测试文件（重点）：`cd poker-ledger-server && node --test test/store.test.js`
- 运行单个用例名（重点）：`cd poker-ledger-server && node --test --test-name-pattern "withLock" test/store.test.js`

## 代码风格（保持一致性优先）

### 语言与模块系统
- 全仓库以 JavaScript 为主，当前使用 CommonJS：
  - 使用 `const x = require("...")` / `module.exports = {...}`
  - 不要在未协商的情况下引入 ESM（`import/export`）或 TypeScript

### 格式化与排版
- 缩进：2 空格
- 引号：双引号
- 分号：保留分号
- 空行：用于分组（require 分组/逻辑分段）
- 变更粒度：避免“顺手全文件格式化/重排”，只改与需求相关的行

### require 分组顺序（参考 `poker-ledger-server/src/index.js`）
- 第 1 组：Node 内置模块（`http`、`path`、`fs`...）
- 第 2 组：第三方依赖（`express`、`ws`、`multer`...）
- 第 3 组：本地模块（`./config`、`./store`...）
- 组间空一行；组内排序保持一致即可（常用优先或字母序二选一）

### 命名约定
- 文件名：单词小写；多词可用 lowerCamel（现有：`wsHub.js`）或全小写（现有：`auth.js`）
- 变量/函数：camelCase
- 常量：UPPER_SNAKE_CASE（现有：`UPLOAD_ROOT`）或集中在 `poker-ledger/miniprogram/utils/const.js`
- 错误码：全大写 + 下划线（现有：`INVALID_AMOUNT`、`UNAUTHORIZED`）
- 小程序事件处理：以 `handle` 开头（现有：`handleJoinRoom`、`handleTapMember`）
- 私有/内部字段：前缀 `_`（现有：`this._socket`、`this._entering`）

### 类型与边界（无 TS）
- 对外接口/关键函数用 JSDoc 标注入参/返回值
- 输入统一归一化：
  - 字符串：`String(x || "").trim()`
  - 房间号：`.toUpperCase()`
  - 数字：`Number(x || 0)` + `Number.isInteger` 校验
- 金额：只允许整数；范围前后端保持一致（参考 `AMOUNT_MIN/MAX` 与后端校验）

### 注释与文案
- 注释与用户可见文案使用简体中文
- 注释优先解释“为什么/约束/协议”，避免复述代码
- 新增公共函数/复杂分支：加 JSDoc 或块注释（现有代码大量采用）

## 后端开发约定（poker-ledger-server）

### 配置（poker-ledger-server/src/config.js）
- 环境变量：
  - `PORT`：HTTP 端口（默认 3000）
  - `JWT_SECRET`：JWT 密钥（生产必须设置强随机值）
  - `WECHAT_APPID` / `WECHAT_APPSECRET`：微信登录换 openid
  - `DB_FILE`：数据文件路径（不设则用 `data/db.json`）
- 不要把任何密钥写进仓库；本地用 `.env` 也不要提交

### API 返回结构（重要）
- 业务接口约定：用 JSON 字段 `ok` 表示成功与否
  - 成功：`{ ok: true, ... }`
  - 失败：`{ ok: false, code, message }`
- 现有实现中，多数业务失败仍返回 HTTP 200（见 `poker-ledger-server/src/index.js` 的 `fail()`）
- 鉴权失败返回 HTTP 401（见 `poker-ledger-server/src/auth.js` 的 `authMiddleware`）
- 新增接口时保持一致：不要引入第二套错误结构/错误码风格

### 并发与数据一致性（重要）
- 写操作必须放在 `store.withLock((db) => { ... })` 内串行化
- 修改 db 后必须 `store.persist()` 落盘（JSON 原子写见 `poker-ledger-server/src/db.js`）
- 只读场景可用 `store._unsafeGetDb()`，但不要在锁外修改其内容

### 错误处理与日志
- 预期内错误：参数校验后快速失败（`return fail(res, "CODE", "提示")` 或 `store.fail(...)`）
- 非预期异常：`try/catch` 后 `console.error`，返回友好错误；不要把堆栈/密钥暴露给客户端
- 不要打印：token、JWT_SECRET、WECHAT_APPSECRET、完整请求体中的敏感字段

### WebSocket 协议（快速参考）
- 连接：`ws://<host>/ws?token=<JWT>`
- 订阅：`{ "type": "subscribe", "roomCode": "XXXXXX" }`
- 推送：
  - `room_snapshot`：包含 room/members/txs
  - `room_dissolved`：包含 roomCode/settlementId
  - `error`：包含 code/message

## 小程序开发约定（poker-ledger/miniprogram）

### 状态与生命周期
- UI 状态放在 `data`，仅通过 `this.setData` 更新
- 连接句柄/定时器等放在 `this._xxx`，不要塞进 `data`
- `onShow` 建连；`onHide/onUnload` 必须关闭 socket/清理定时器（现有 `room` 页遵循）

### 网络与鉴权
- 后端请求统一走 `App.apiCall`（自动 ensureSession + 处理 UNAUTHORIZED 重登一次）
- 只在必要场景（如 `wx.uploadFile`）手动拼 header/token
- 后端地址只从 `poker-ledger/miniprogram/utils/const.js` 读取；不要在页面里硬编码 IP/端口

### 授权与用户输入
- `wx.getUserProfile` 必须由用户点击触发；用户取消属于正常分支
- 新版优先：`chooseAvatar` + `input(type="nickname")`（现有 `home` 页已实现）
- 用户可感知的失败：`wx.showToast({ icon: "none" })`；非关键兜底失败可静默

## Cursor / Copilot 规则
- 未发现：`.cursor/rules/`、`.cursorrules`、`.github/copilot-instructions.md`

## 本地数据与敏感信息（不要泄露/提交）
- `poker-ledger-server/data/db.json`、`poker-ledger-server/data/uploads/` 可能包含真实数据/头像
- `project.private.config.json` 通常包含本机路径与个人配置
- 任何密钥仅通过环境变量提供，不要写进仓库/日志
