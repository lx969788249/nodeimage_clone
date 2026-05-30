FROM node:18-alpine

WORKDIR /app

# 安装依赖（包含构建 sqlite3 的工具链）
COPY package*.json ./
RUN apk add --no-cache python3 make g++ sqlite sqlite-dev \
    && npm ci --production

# 拷贝应用代码
COPY public ./public
COPY server.js ./server.js
RUN mkdir -p uploads data

ENV PORT=7878
EXPOSE 7878
VOLUME ["/app/uploads", "/app/data"]

# 启动服务
CMD ["node", "server.js"]
