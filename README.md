# Nodeimage 克隆版

## 唠嗑

自己闲来无事仿照nodeimage搓了一个复刻版图床出来，本来想着自己用，后来想了一下还是分享吧。

[演示网址](https://tc.lxvps.eu.org/)



## 介绍

本项目是对 https://www.nodeimage.com 的本地可部署克隆，保留了原站的界面、动画和核心功能：拖拽/粘贴上传、WebP 压缩、水印、历史记录、API 密钥、复制多格式链接、暗黑模式等。后端基于 Express + sharp，文件与数据均存储在本地。

## Docker run部署

### 直接运行
```bash
mkdir -p /root/nodeimage_clone/{data,uploads} && \
docker run -d --name nodeimage_clone \
  --restart unless-stopped \
  -p 7878:7878 \
  -e SESSION_SECRET=change_me \
  -v "/root/nodeimage_clone/uploads:/app/uploads" \
  -v "/root/nodeimage_clone/data:/app/data" \
  lx969788249/nodeimage_clone:latest
```
访问 `http://localhost:7878` 登录，*默认账号：**admin** 默认密码：**admin***

再按需修改账号密码。

### Docker Compose（推荐）

创建并进入文件夹

```bash
mkdir -p /root/nodeimage_clone/{data,uploads} && cd nodeimage_clone
```

新建 `docker-compose.yml`，输入下面的内容
```yaml
services:
  nodeimage:
    image: lx969788249/nodeimage_clone:latest
    ports:
      - "7878:7878"
    restart: unless-stopped
    environment:
      SESSION_SECRET: change_me   # 自定义字符串，用于安全校验，随便填，不用记
      # BASE_URL: https://img.example.com
    volumes:
      - /root/nodeimage/uploads:/app/uploads
      - /root/nodeimage/data:/app/data
```
执行保存之后执行
```bash
docker compose up -d
```

访问 `http://localhost:7878` 登录，*默认账号：**admin** 默认密码：**admin***
