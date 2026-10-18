FROM node:24-alpine

WORKDIR /app

# 安装依赖（包含构建 sqlite3 的工具链）
COPY package*.json ./
RUN apk add --no-cache python3 make g++ sqlite sqlite-dev \
    && npm ci --omit=dev

# 拷贝应用代码
COPY public ./public
COPY lib ./lib
COPY server.js ./
RUN mkdir -p uploads data

ARG APP_VERSION=""
ARG APP_REVISION=""
ENV APP_VERSION=$APP_VERSION APP_REVISION=$APP_REVISION
RUN node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { installedVersion } from "./lib/network.js"; installedVersion(JSON.parse(await readFile("./package.json", "utf8")).version, process.env.APP_VERSION);'
ENV PORT=7878
EXPOSE 7878
VOLUME ["/app/uploads", "/app/data"]

# 启动服务
CMD ["node", "server.js"]
