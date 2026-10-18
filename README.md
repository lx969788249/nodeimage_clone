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
      - /root/nodeimage_clone/uploads:/app/uploads
      - /root/nodeimage_clone/data:/app/data
```
执行保存之后执行
```bash
docker compose up -d
```

访问 `http://localhost:7878` 登录，*默认账号：**admin** 默认密码：**admin***

## 本地开发与回归测试

运行时为 **Node.js 24 LTS**（`.nvmrc` 和 Docker 使用同一主版本）。

```bash
npm ci
npm test
npm audit --omit=dev
```

测试启动仅监听 `127.0.0.1` 的子进程，使用系统临时目录及随机端口，不读取或修改部署目录。覆盖并发上传、账号撤销、WAL 快照、恶意/损坏归档、恢复中途故障及 SIGKILL 后重启。CI 在 Linux 和 macOS 上执行相同命令。

可用 `STORAGE_ROOT=/absolute/path` 指定隔离存储根目录；其中 `data/`、`uploads/` 必须属于同一个应用实例。更新后的实例启动前会在 data 和 uploads 各自持有独立 SQLite 排他锁，第二个共享任一目录的新版实例会在清理/恢复前以 STORAGE_IN_USE 退出；进程退出或 SIGKILL 后由系统释放锁。不要删除仍在使用的 `.nodeimage-instance.sqlite` 文件。升级时必须先停旧版；旧版程序、外部 SQLite 工具及多机器网络文件系统不受这个协作锁保护。仍不支持 PM2 cluster、多副本共享卷。默认路径仍是项目目录，已有 Docker 挂载路径无需调整。

### 数据与认证兼容性

- 数据库启动时补齐历史 `sessionVersion` 列及删除重试表，并在原路径不存在时修正“缩略图已在 thumbs/ 下”的 basename 或日期目录路径。历史 AVIF 的 `.heif` 链接经实际格式核对后修正 MIME，文件不搬家。已有原图不搬家；不再从目录自动补录图片，避免复活已删除的账号或记录。
- 密码或用户名变更使旧 cookie 会话失效。API key 是独立凭据，改密后继续有效；通过“重新生成 API key”或删除账号撤销。显式提供 `x-api-key` 时使用该凭据，即使同时携带 cookie。
- 新注册/新设密码按 UTF-8 限 72 字节，避免 bcrypt 截断产生等价密码；旧密码登录仍接受历史输入（请求字段限 4096 字符），旧的长密码应在登录后修改。用户名上限 30。非字符串输入返回 400。
- 原生依赖升级到 sharp 0.35 与 sqlite3 6；镜像改用 Node 24 Alpine。旧 Node 18/20 不再支持。

### 上传资源上限

上传前按账号和全局预留名额：全局最多 3 个、单账号最多 2 个接收/处理任务，无等待队列；超载返回 429。图片先写私有临时目录，默认单文件上限 **100 MiB = 104857600 字节**（保留原项目 `100 * 1024 * 1024` 语义），可用 `UPLOAD_MAX_FILE_MIB=1..100` 配置更低上限，非法配置启动失败；前端读取服务器上限并预检，解码上限 **4000 万像素**，接收超时 60 秒。失败、断连或进程重启会清理暂存文件。逻辑删除时先在同一事务登记持久删除任务；文件系统失败仍阻止对应公开链接（含编码/大小写别名），启动、定时清理和后续删除会重试。缩略图再生独立限制全局 2 个、每个图片所属账号 1 个任务。

### 备份与恢复

手动及自动备份使用 SQLite online backup API，包含 WAL 中已提交的数据；图片只打包数据库中登记的原图和缩略图。缺失文件会使备份失败，不会输出一个宣称完整的残缺备份。旧版直接打包在线 db.sqlite 造成的历史缺失提交无法由新代码补回。

恢复先在隔离目录完整解包并校验，拒绝路径穿越、软/硬链接、重复条目、错误数据库结构、缺失图片及未登记文件。压缩文件上限 1 GiB，展开上限 4 GiB、50000 条目，数据库文件上限 256 MiB，归档内单图片上限 100 MiB。超出这些界限的历史归档需离线迁移。备份生成不会强制降低整个图库的容量，因此大图库可能生成超过默认恢复限额的归档，恢复前需核对规模并安排离线迁移。

备份和恢复在维护期间阻止新请求（503），最多等待在途处理和图片传输 30 秒；超时保持现有数据不变。恢复先将校验后的图片复制到 uploads 卷内的私有暂存目录，再通过日志协调 `data` 与 `uploads` 两个挂载点的同卷切换，并在进程异常退出后、再次监听之前回滚未提交的切换。所有旧 cookie 会话在恢复后清除。成功恢复保留：

- `data/rollback-<id>/db.sqlite` 与 `manifest.json`
- `uploads/.rollback-<id>/` 中的原图片集合（不会公开静态提供）

这些回滚数据不会自动删除，需要运维确认后离线清理，并预留容纳归档、展开文件、uploads 卷内的暂存副本及旧数据的磁盘空间。该机制提供应用请求与进程崩溃恢复的一致性；没有对断电、磁盘损坏、文件系统故障或跨机器共享卷作保证。恢复使用归档内的账号/API key 和设置，应把备份当作敏感管理文件保存。

### 自动备份与部署配置

备份设置优先级为环境变量高于数据库。环境变量覆盖的值应从部署配置修改；保存界面设置不会覆盖环境变量。支持 intervalHours 1..720（长定时器按安全片段调度）、整数 keepCount 1..365。S3 轮转跟随分页，本地轮转按文件修改时间兼容旧备份名称。每次运行使用同一份配置，Webhook 流式发送且有超时；远端失败返回 502 和各目标结果；未配远端时明确只完成本地备份。

默认无需配置代理：直连 HTTP 可登录；常见 HTTPS 反代保留 Host 并覆盖单值 `X-Forwarded-Proto: https` 即可得到 HTTPS 图片链接和 Secure 会话 Cookie。未设 `TRUST_PROXY` 时，Express 不信任转发 IP，XFF 不参与登录、上传或缩略图资源额度；仅接受单值 http/https 协议提示供链接和 Cookie 使用。真实 TLS 优先；忽略 Origin、Referer、X-Forwarded-Host 和无效/多值协议提示。登录与注册重建会话，避免旧 HTTP Cookie 策略残留。

登录成功不消耗失败额度。失败按账号计数，超过每分钟 10 次（或全局 100 次）时失败响应变为 429，并给出 Retry-After；失败逐渐退避，最多 2 秒。最多同时验证 8 个登录，满额立即 AUTH_BUSY/429；断连仍持有许可直至验证/退避完成。账号状态最多 1024 条。正确密码仍会验证，成功清除该账号失败记录，不因其失败历史锁号；全局过载时仍可能短暂拒绝正常请求。这些阈值控制失败响应与资源占用，**不代表每分钟只会验证 10/100 个密码**，持续攻击仍受服务吞吐量限制。

高级部署可选 `TRUST_PROXY=false`（完全忽略转发头）、Express 可信 IP/CIDR 列表或非负整数跳数。只有显式信任的直接对端可通过 X-Forwarded-Host 改变链接域名；`true` 是主动信任所有代理的高级选项，不是默认值。没有自动猜测内网可信范围；不同路径/跳数的复杂代理不能保证自动识别。反代应覆盖协议头，不要转发客户端原值。默认兼容模式中，客户端伪造 https 提示只能改变自己收到的链接/Cookie，不能改变账号身份或资源额度，但可能使自己的 HTTP 会话不可用。

可选 `BASE_URL=https://images.example.com` 固定公开域名，也支持路径前缀；只允许合法 HTTP(S) URL，不允许凭据、查询、片段或控制字符。Host 仅做语法校验，无法自动确认它是否属于本站，固定域名需求应使用 BASE_URL。默认忽略 X-Forwarded-Host，所以会改写 Host 的反代需保留原 Host，或配置 BASE_URL/明确代理信任。Cookie 的 Secure 跟随请求协议，不根据 BASE_URL 推断连接安全；HTTP 直连可用也意味着 HTTP 本身不提供传输加密。

恢复将已验证的记录导入应用规范表结构，丢弃备份自带的额外索引、CHECK/COLLATE 等约束；pending_deletions 是运行时删除队列，归档不含其待删文件，恢复时不导入旧队列。旧的未登记文件不会自动归入管理员账号，必要时由运维离线核对。
