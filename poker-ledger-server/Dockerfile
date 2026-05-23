# 多阶段构建: 依赖安装阶段
FROM node:18-alpine AS deps

WORKDIR /app

# 复制依赖定义文件
COPY package.json package-lock.json ./

# 安装生产依赖
# better-sqlite3 需要编译,因此需要 build-base python3
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    apk del python3 make g++

# 生产镜像阶段
FROM node:18-alpine

WORKDIR /app

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 从依赖阶段复制 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制应用代码与后台静态资源，确保 /admin 页面在容器内可访问
COPY src ./src
COPY web ./web
COPY package.json ./

# 创建数据目录
RUN mkdir -p /app/data/uploads && \
    chown -R nodejs:nodejs /app/data

# 切换到非 root 用户
USER nodejs

# 暴露端口(内部使用)
EXPOSE 3000

# 启动命令
CMD ["node", "src/index.js"]
