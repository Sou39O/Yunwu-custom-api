# Yunwu Custom API

面向个人用户的 AI 图片生成与编辑工作台。`v0.7.0` 是轻量化重构版本：**彻底移除 Docker/PostgreSQL/Redis/MinIO 依赖**，整个后端（API + 任务队列 + Web 静态托管）合并为单个 Node 进程，数据落地 SQLite 与本地文件系统，桌面版冷启动约 2-3 秒（远低于 20 秒目标）。首次启动可自动迁移 v0.6.1 的 Docker 卷数据。

当前推荐版本：`v0.7.3`

## 当前能力

- 个人用户注册、登录、登录态恢复、权限路由回跳
- 首页、创建页、工作台、历史页、作品库
- 文生图、上传图编辑、来源任务继续创作、变体、Fork、失败恢复
- 自动提示词分发：创建页和工作台输入 `{prompt:"..."},{prompt:"..."}` 可解析为同一会话内的多条独立任务
- 批量并发图片请求：一个任务卡承载 1-20 个并发结果，支持批量进度、部分完成、失败槽位重试
- 工作台图片浮层预览：结果图按 100% 原图缩放打开，点击浮层即可关闭
- 进程内异步任务队列（替代 BullMQ/Redis），支持并发控制、重试退避、SSE 与轮询状态刷新
- 作品库批量下载：多选后打包成 zip，文件名按「日期 + 哈希前几位」生成，批量任务与单张作品可混合选择
- 生成结果自动落盘：上游返回后立即下载到本地存储；失败会重试，仍失败的作品在服务启动后与运行期间自动补存到本地，避免只剩会过期的上游临时链接
- SQLite（Prisma）+ 本地文件存储（替代 PostgreSQL/MinIO），可选 S3 兼容对象存储
- 管理台 `/admin`：provider/model 配置、任务与健康状态、DEBUG 级运行日志辅助排障
- Windows portable Electron 桌面壳：内置 Node 服务进程，无需 Docker、无需安装依赖，开箱即用
- v0.6.1 旧数据自动迁移：检测到旧 Docker 卷时自动导入 SQLite/本地存储（仅迁移时需要 Docker）

## 架构（v0.7.0）

```
Electron 桌面壳
  └─ 子进程（ELECTRON_RUN_AS_NODE）: 单个 Node 服务进程
       ├─ NestJS API（/api/*、/health、/readiness）
       ├─ 进程内任务队列 + Worker（TASK_WORKER_ENABLED=true）
       ├─ Web 静态托管（同端口，SPA fallback）
       ├─ SQLite（Prisma，启动时自动应用迁移）
       └─ 本地文件存储（userData/data/storage）
```

## 仓库结构

- `apps/api`：NestJS API、鉴权、进程内任务队列、SSE、Prisma(SQLite)、旧数据迁移工具（`src/tools/legacy-import.ts`）
- `apps/web`：Vite + React 前台工作台与管理页
- `apps/desktop`：Electron 桌面壳（拉起内置服务进程、旧数据迁移编排、端内更新下载与替换）
- `packages/shared`：共享类型与常量
- `.github/workflows/release.yml`：发布工程 workflow（构建桌面 portable zip 与更新清单）
- `docs/release/v0.7.3.md`：当前版本发布说明

## Windows Portable 使用

前置条件：

- Windows 10/11
- （仅当需要迁移 v0.6.1 旧数据时）Docker Desktop

解压 Release artifact 中的 `Yunwu Desktop-0.7.3-win-x64-portable.zip`，直接运行桌面程序即可。桌面壳会：

1. 在 `%APPDATA%/yunwu-desktop/data` 下创建 SQLite 数据库与本地存储目录
2. 首次启动时检测 v0.6.1 Docker 卷；若存在且 Docker 可用，自动迁移旧数据（用户、会话、任务、图片资产）
3. 启动内置 Node 服务进程并打开工作台窗口

### 端内更新

壳状态页的「版本更新」卡片会在启动时检查 GitHub Release。发现新版且发布清单带 `sha256` 时，点「下载并更新」即可在应用内完成：

1. 从 Release 下载 portable zip（只接受本仓库 Release 的下载地址）
2. 按 `yunwu-release.json` 里的 `sha256` 与文件大小校验，不一致直接丢弃
3. 解压到 `%APPDATA%/yunwu-desktop/updates` 下的临时目录
4. 退出主进程后由替换脚本覆盖程序目录并自动重启

数据目录在 `%APPDATA%/yunwu-desktop`，不在程序目录内，更新不会影响数据库与已生成图片。若程序被放在无写入权限的位置（如 `Program Files`），按钮不会出现，卡片会提示手动下载。

对着线上 Release 验证整条更新链路（下载 → 校验 → 解压 → 生成替换脚本，不执行替换）：

```bash
node apps/desktop/scripts/verify-update-flow.cjs
```

访问地址（默认端口 3000，被占用时自动改用随机端口）：

- Web / 管理台：`http://127.0.0.1:3000` 与 `http://127.0.0.1:3000/admin`
- Health / Readiness：`http://127.0.0.1:3000/health`、`http://127.0.0.1:3000/readiness`

### v0.6.1 数据迁移说明

- 迁移只需一次；完成后写入 `data/legacy-migration.json`，之后不再触发
- 迁移期间会用 Docker 临时拉起旧 postgres/minio 容器读取数据，结束后自动清理容器，**旧数据卷保留不动**
- 若首次启动时 Docker 未运行，可先启动 Docker Desktop，再在桌面壳状态页点击"迁移旧数据"手动触发
- 若本地数据库已有内容，自动迁移不会执行，需在状态页手动触发（会覆盖现有数据）

## 本地开发（无需 Docker）

前置条件：Node.js 22+、`pnpm@10.17.1`（Corepack）。

```powershell
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm local:prepare        # 生成 .env、安装依赖、构建 shared

pnpm --filter @yunwu/api dev    # API + SQLite + 内置任务队列 (http://127.0.0.1:3000)
pnpm --filter @yunwu/web dev    # Web (http://127.0.0.1:5173)
```

数据库文件默认位于 `apps/api/data/yunwu.db`（`DATABASE_URL=file:./data/yunwu.db`），启动时自动应用 `prisma/migrations` 下的 SQLite 迁移，无需 Prisma CLI。

常用命令：

```powershell
pnpm local:test           # auth + web 路由测试
pnpm desktop:typecheck    # 桌面壳类型检查
pnpm desktop:package      # 构建桌面 portable zip（含内置服务与 Web 产物）
```

## 配置

关键环境变量见 [.env.example](.env.example)：

- `DATABASE_URL`：SQLite 文件路径（`file:` 前缀）
- `TASK_WORKER_ENABLED` / `TASK_WORKER_CONCURRENCY`：进程内任务队列开关与并发
- `STORAGE_MODE`：`local`（默认）或 `s3`（配合 `S3_*` 变量）
- `WEB_DIST_DIR`：设置后 API 进程同端口托管 Web 构建产物
- `RUN_MIGRATIONS_ON_BOOT`：启动时自动应用 SQLite 迁移（桌面版默认开启）

## API Key 配置

默认上游为 **APIXO Generation API**（异步任务式：`POST /generateTask/{model}` 提交 → `GET /statusTask/{model}` 轮询，由后端内部完成轮询）。真实上游调用需要在 `.env` 设置：

```env
PROVIDER_TYPE=apixo
APIXO_BASE_URL=https://api.apixo.ai/api/v1
APIXO_API_KEY=your_apixo_api_key_here
```

可选切换回 Yunwu / OpenAI 兼容上游：

```env
PROVIDER_TYPE=openai-compatible
YUNWU_BASE_URL=https://yunwu.ai
YUNWU_API_KEY=your_api_key_here
```

API key 留空时适合本地联调或 mock-oriented 验证；真实图片生成、编辑和 provider 检查应配置有效 key。三套上游的模型清单独立（APIXO 默认启用 `nano-banana`、`nano-banana-pro`、`gpt-image-1`、`gpt-image-2`、`grok-image`、`flux-2`、`seedream-4-0` 等），管理台 `/admin` 可启停模型。

### 可选上游线路

| 线路 | 地址 | 调用格式 |
| --- | --- | --- |
| APIXO（默认） | `https://api.apixo.ai/api/v1` | 异步任务式，后端内部轮询 |
| Yunwu / AnyAIGC | `https://yunwu.ai` / `https://anyaigc.com` | OpenAI Images 兼容 |
| OpenLux | `https://api.openlux.ai/v1` | OpenAI Images 兼容（[文档](https://doc.openlux.ai/reference/v1/images/)） |

用户也可以在设置页自行切换线路并填入该线路自己的 key，互不影响。

## 默认账号

默认值来自 `.env.example`：

- Admin：`admin@yunwu.local` / `admin123456`
- Demo：`demo@yunwu.local` / `demo123456`

普通用户也可以直接通过 Web 注册。

## 管理台与 DEBUG 日志

管理员登录后进入 `/admin`。管理台用于查看 provider/model 状态、任务运行状态、配置项和 DEBUG 级排障信息。桌面版可在壳状态页查看内置服务进程日志。

## 发布策略

打 `v*` tag 或手动触发 GitHub Actions Release workflow：

- 执行 `pnpm desktop:package` 生成 Electron portable zip（内含 API 服务、Web 产物与生产依赖）：`apps/desktop/release/*portable.zip`
- tag 触发时上传 Electron zip 和 `yunwu-release.json` 到 GitHub Release；manual dispatch 默认只产出 workflow artifact，勾选 `publish_release` 后上传 Release
- 桌面壳启动时检查 GitHub Release；清单带 `sha256` 时支持端内下载并自动替换重启，否则回退到手动下载

## 常见故障

- 任务一直 `queued`：确认 `TASK_WORKER_ENABLED=true`（默认开启），查看 `/readiness` 的 `queue` 检查项。
- 真实生成失败：确认 `APIXO_API_KEY`（或 Yunwu 模式下的 `YUNWU_API_KEY`/`YUNWU_BASE_URL`）、provider/model 配置有效。
- 登录态丢失：本地默认应使用 `AUTH_COOKIE_SECURE=false`，并避免混用 `localhost` 与 `127.0.0.1`。
- 端口被占用：桌面壳自动改用随机端口，实际地址见壳状态页。
- 旧数据迁移失败：确认 Docker Desktop 已启动后在状态页重试；迁移不会删除旧数据卷，可反复执行。
- SQLite 文件被占用：Windows 下先关闭所有 `node.exe` / 桌面程序进程再重试。

## 更多文档

- Windows 本地启动与测试：[docs/qa/windows-local-startup.md](docs/qa/windows-local-startup.md)
- 桌面发布、账号与用户侧更新策略：[docs/release/desktop-release-strategy.md](docs/release/desktop-release-strategy.md)
- v0.7.3 发布说明：[docs/release/v0.7.3.md](docs/release/v0.7.3.md)
- v0.7.2 发布说明：[docs/release/v0.7.2.md](docs/release/v0.7.2.md)
- v0.7.1 发布说明：[docs/release/v0.7.1.md](docs/release/v0.7.1.md)
- v0.7.0 发布说明：[docs/release/v0.7.0.md](docs/release/v0.7.0.md)
- v0.6.1 发布说明：[docs/release/v0.6.1.md](docs/release/v0.6.1.md)
