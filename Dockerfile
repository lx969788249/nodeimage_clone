FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --production

# 拷贝应用代码
COPY public ./public
COPY server.js ./server.js
RUN mkdir -p uploads/thumbs data

ENV PORT=7878
EXPOSE 7878

# 启动服务
CMD ["node", "server.js"]
