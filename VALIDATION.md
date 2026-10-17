# 修复与验证记录

基线：`main` / `93f7ce42dceeae8a15ebe8d2aa517d1ce8345582`。
分支：`fix/data-safety-regressions`。所有操作位于新克隆目录，无已有修改；未推送、创建 PR、合并、部署或读取生产目录。

## 实现

1. 所有 Express 4 路由共享异常边界，异步中间件亦受保护；登录、注册、账号变更及水印等入口严格校验字符串。
2. 删除 loadDb/saveDb 的整库快照与全表重插。写入使用增量 SQL、BEGIN IMMEDIATE 和进程内事务串行化；上传解码在事务外，提交时重新查询账号并检查对应凭据。删除账号和图片、改密、改名、API key 轮换、注册、旧账号首次设密、品牌和备份设置、过期清理及缩略图再生均已检查。
3. 手动/自动备份共享 SQLite online backup API；维护屏障排空处理后拷贝登记的图片，包含 WAL 已提交数据，不再 tar 正在使用的主库文件。
4. 恢复在隔离目录限额解包，校验路径、链接、重复及大小写/Unicode 别名、完整性、表/列/主键/用户名唯一约束、引用账号与图片集合。随后复制到 uploads 卷内的私有暂存目录，以同卷重命名切换；持久日志在进程退出后供启动回滚，提交后保留旧库/图片。回滚失败则所有请求返回 503，保留日志供重启恢复。
5. API key 与 cookie 会话分离。改密撤销旧 cookie；API key 持续有效，直到轮换或删除账号。写事务再次检查已撤销的凭据。
6. Multer 接收前限制全局 3 个、每账号 2 个，无等待队列。磁盘输入限 20 MiB、60 秒；sharp 限 4000 万像素。失败与断连在处理实际结束后清理输入、半成品和名额，启动清除遗留暂存。
7. Node/Docker/CI 对齐 Node 24；升级 Multer 2.4、sharp 0.35.5、sqlite3 6.0.1、tar 7.5.22 及兼容补丁锁版本。用 Node 原生 watch 代替有漏洞的 nodemon 开发依赖。无 UI 修改。

## 已实际执行

Mac mini / macOS arm64；系统 Node 25.9.0 未更改。测试使用 `/tmp/nodeimage-node24/node_modules/node/bin/node`，版本 **24.22.0**。

```bash
export PATH=/tmp/nodeimage-node24/node_modules/node/bin:$PATH
npm ci --cache /tmp/nodeimage-npm-cache
npm test
npm audit
node --check server.js
node --check backup.js
node --check safety.js
git diff --check
```

- `npm ci` 成功；最终 **26 项通过，0 失败/跳过**。
- 全依赖及生产依赖审计均为 **0 项已知漏洞**；审计只代表执行时数据库中的已知问题。
- 语法及差异空白检查通过。
- 测试在临时目录、随机端口、127.0.0.1 运行。初次沙箱不允许监听（EPERM），随后使用批准的本地执行重跑。一次初期测试发现畸形 multipart 被误报 500，已修正为 400。故障注入也发现库代码设置 process.exitCode 会影响测试进程，现以维护屏障关闭准入。

覆盖：畸形认证/JSON 与数据库拒绝时进程存活；慢上传与改密/删账号/轮换 key/删除图片/设置并发；每日配额；全局/账号超载与断连/坏图片/超大文件清理；手动和自动 WAL 快照；有效恢复及坏包不改库/图片/凭据；恢复排空；三个同步切换故障回滚；六个阶段真实 SIGKILL 后启动（含部分旧图搬走、部分新图安装、提交点前后）；回滚 I/O 失败关闭准入；维护超时；旧数据库列和缩略图路径；模拟跨挂载点 EXDEV，确认所有切换重命名都在各自卷内。

## 独立复查

完成实现后重新逐条检查写路径、启动迁移、异步处理寿命和恢复日志状态机，并通过故障注入核对。

- 修正后台备份在快照屏障外读取配置的寿命保护。
- 缩略图再生增加有界解码和写入前记录复查，避免图片删除后再生成文件。
- 修正回滚失败时静态资源也必须关闭准入。
- 识别 data/uploads 分卷导致 EXDEV 的风险，改为上传卷内暂存后切换，并添加模拟限制回归。
- 备份设置的部分更新改为在事务内读取当前值，避免并发覆盖。
- 迁移不再移动原图或重建表，只增补缺失列及修正已有缩略图的相对路径；登录不得重建默认用户或副作用迁移。

## 未验证与兼容性边界

- Docker 引擎 29.8.2 可连接。执行 `docker build --progress=plain -t nodeimage-clone:regression-local .`，在获取 `docker.io/library/node:24-alpine` 元数据时 DeadlineExceeded，未进入安装/构建应用阶段。本机无缓存镜像，因此 **Docker 构建、Alpine 原生依赖、真实双挂载点恢复均未验证**。EXDEV 是注入限制的测试，不是实际 Docker 卷实验。
- 未连接 S3/Webhook；自动备份测试验证了本地生成并跳过未配置目标，未验证外部上传/远端轮转。未推送分支，因此 GitHub Actions 的 Linux/macOS 矩阵尚未实际运行。
- 支持单进程单实例；不支持 cluster、多副本共享卷或外部进程并发改库。进程 SIGKILL 一致性已测，断电/磁盘损坏/任意文件系统故障一致性没有验证或保证。
- 文件上限从 100 MiB 降到 20 MiB；历史大归档受 1 GiB 压缩/4 GiB 展开等限额约束；旧版缺失 WAL 的坏备份不能补回提交。回滚目录保留且不自动轮转，需运维离线清理。没有进行最大容量或长期压力测试。
- sqlite3 6 的本地兼容已测，但其[上游仓库已归档](https://github.com/TryGhost/node-sqlite3/releases)，后续应单独评估驱动维护方案。

参考：[Node 发布支持状态](https://nodejs.org/en/about/previous-releases)、[Multer 发布记录](https://github.com/expressjs/multer/releases)、[SQLite backup API](https://www.sqlite.org/backup.html)。
