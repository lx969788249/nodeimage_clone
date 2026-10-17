# 修复与验证记录

基线 main：`93f7ce42dceeae8a15ebe8d2aa517d1ce8345582`。初次提交 `0e7be72`，后续修复均在 `fix/data-safety-regressions`。没有改main、推送、PR、合并、部署或访问生产数据。

## 本机环境与复现

Mac mini / macOS arm64；系统Node25.9未改，实际安装和测试使用独立Node **24.22.0**。

```bash
export PATH=/tmp/nodeimage-node24/node_modules/node/bin:$PATH
npm ci --cache /tmp/nodeimage-npm-cache
npm test
npm audit
node --check server.js
node --check backup.js
node --check safety.js
node --check storage.js
node --check backup-delivery.js
node --check public/assets/js/main.js
git diff --check
```

最终整合回归 **66/66通过，0失败、0跳过**；完整输出保存在根目录外的 `nodeimage-test-results.log`。全套测试包括所有独立审查新增回归，全部使用临时存储根目录、127.0.0.1及随机端口；没有跳过失败用例。最初沙箱EPERM监听限制后，使用批准的本地执行运行。

干净npm ci成功；npm audit全依赖与生产依赖均 **0项已知漏洞**。审计仅代表执行时数据库的已知问题，不证明没有未知漏洞。

## 原六项修复及兼容补强

- 统一Express4路由/中间件异常边界与严格输入；不再未捕获异步登录异常。
- 去掉整库快照/整表重插，增量SQL与BEGIN IMMEDIATE，提交前校验当前身份。覆盖所有写路径及持久删除任务。
- 手动/自动备份共同使用SQLite online backup API，协调登记图集，包含WAL已提交数据。
- 恢复隔离解包、路径/链接/配额/SQL/图片验证及规范表导入；图片在uploads卷内准备，每卷内部重命名；日志回滚、提交标记、保留原数据及启动恢复。
- API key与cookie撤销独立；改密撤销旧会话，轮换key/删账号撤销key，慢上传不能恢复旧权限。
- 接收前全局3/账号2准入，无等待队列；磁盘暂存、100MiB默认（104857600字节）、配置和真实边界测试、断连/错误清理。
- 更新Node24、Multer、sharp、sqlite3、tar、锁文件；Linux/macOS测试CI及Docker发布测试依赖，无部署操作。

本轮扩大审查的发现、修复与精简详见 [REVIEW.md](REVIEW.md)。初版所谓独立复查为实现者自查；本轮实际增加四位独立子代理：前端、后端、备份、配置。后端独立10/10、前端12/12、备份最终指定三组10/10；父代理执行全套整合测试。它们不是人工外部审计。

## 实际测试证据

包含畸形JSON/认证存活、并发上传/改密/删账号/轮换key/删图/设置、每日配额、超载与断连、100MiB及+1字节、两卷实例锁与SIGKILL释放、旧列和缩略图/AVIF迁移、WAL手动/自动备份、坏归档保持live不变、六阶段真实SIGKILL、切换和多次回滚I/O失败、模拟EXDEV同卷重命名、小数保留参数前置拒绝、规范schema导入、实际图片格式拒绝、暂停静态传输排空、本地S3两页轮转与Webhook流式失败/超时、720小时安全定时分段、前端DOM行为等。

故障注入日志中出现 `Injected ...` 和 `Restore rollback failed` 是预期测试分支，最终回归要求恢复原行/图片字节并通过，不是忽略真实运行失败。

## 未验证与已知边界

- Docker29.8.2引擎可连，但构建在docker.io/library/node:24-alpine元数据阶段DeadlineExceeded，未进入应用安装。因此Docker/Alpine原生依赖、真实双卷恢复均未通过验证；EXDEV为模拟限制。
- 本地HTTP模拟S3/Webhook已测，真实云服务、S3大包multipart及真实远端轮转未验。未推送，远端GitHub Actions也未执行。
- Chrome只验证首页/100MiB动态说明/登录框；后续被已有扩展UI拦截。Playwright CLI获取受npm DNS限制，未以完整浏览器端到端通过交付；VM生产脚本行为测试已执行。
- TRUST_PROXY默认仍true为旧部署兼容，直连可伪造XFF绕限频，**部署前需按实际代理设置false或可信IP/CIDR**。默认风险并未消除，已记录待用户/运维决定；false配置的阻断测试通过。
- 协作锁不保护旧版本/外部工具/网络共享文件系统；旧版本必须停止。仅支持单机单实例。
- SIGKILL一致性不等于断电、磁盘损坏或任意硬件故障保证；未做长期压力和所有容量组合实验。回滚数据保留需运维离线清理。
- 旧WAL缺失不能补回。大图库备份可超过默认恢复限额，需容量规划/离线迁移。旧孤儿文件不自动索引，非应用约束不保留，新密码72字节而旧长密码需自行改密。
- sqlite3上游已归档，维护迁移另行安排。

参考：[Node发布支持](https://nodejs.org/en/about/previous-releases)、[Multer发布](https://github.com/expressjs/multer/releases)、[SQLite backup API](https://www.sqlite.org/backup.html)、[sqlite3维护状态](https://github.com/TryGhost/node-sqlite3/releases)。
