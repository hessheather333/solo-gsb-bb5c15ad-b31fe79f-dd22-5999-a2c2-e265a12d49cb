# 无线麦克风频率协调器 —— 生产镜像
# better-sqlite3 为原生模块：优先使用官方预编译二进制，失败时回退本地编译
FROM node:20-bookworm-slim

# 原生模块编译回退所需的最小构建工具链（prebuild 命中时也不会有害）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单以利用 Docker 层缓存
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 拷贝应用源码
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# 简单的存活探测：HTTP 首页可访问
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
