# Desktop Release Strategy

本文用于恢复和固定桌面端发布策略，避免发布记录再次散落在 workflow、package 配置和 release notes 中。除特别说明外，本文描述的是 `v0.4.3` 已验证策略，以及在此基础上实现用户侧 release 更新的推荐路径。`v0.5.0` 的细化设计见 [v0.5.0 用户侧更新设计](v0.5.0-user-update-design.md)。

## 架构边界

仓库采用 pnpm workspace monorepo：

- `apps/api`：NestJS API、Auth、Prisma、任务入队、SSE、资产访问控制。
- `apps/web`：Vite + React 用户端与管理台。
- `apps/desktop`：Electron 桌面壳，负责 Docker Desktop 检查、运行时文件生成、Compose 启停和桌面启动页。
- `infra`：基础 Compose 文件、桌面 Compose 覆盖文件、Nginx 和 MinIO 初始化脚本。
- `packages/shared`：跨前后端共享枚举、类型和模型常量。

发布与更新相关能力应按边界落位：

- 构建和上传 release artifact 属于 `.github/workflows/release.yml`。
- 桌面包格式、资源打包和 artifact 命名属于 `apps/desktop/package.json`。
- 桌面运行时的 Docker/Compose 编排属于 `apps/desktop/src/main/main.ts`。
- 业务镜像、端口、环境变量和服务依赖属于 `infra/docker-compose*.yml`。
- 用户账号、角色、会话和业务数据隔离属于 `apps/api/src/auth` 与 `apps/api/src/api`，不要放进 Electron 主进程。
- Web 只消费 API 和桌面暴露的明确 IPC 能力，不直接操作 Docker、文件系统或 GitHub release。

## v0.4.3 制作策略

`v0.4.3` 的 Electron 包不是安装器，也不内置 API/Web/Worker 产物。它是一个 Windows x64 portable zip 桌面壳，业务服务通过 GHCR Docker 镜像运行。

触发方式：

- 推送 `v*` tag 会运行 Release workflow 并上传 GitHub Release。
- 手动 `workflow_dispatch` 默认只生成 workflow artifact；只有 `publish_release=true` 时才上传 GitHub Release。

CI 产物：

- `ghcr.io/alterego-42/yunwu-custom-api-api:v0.4.3`
- `ghcr.io/alterego-42/yunwu-custom-api-worker:v0.4.3`
- `ghcr.io/alterego-42/yunwu-custom-api-web:v0.4.3`
- `Yunwu.Desktop-0.4.3-win-x64-portable.zip`

CI 步骤：

1. Ubuntu job 使用 Docker Buildx 按 `api`、`worker`、`web` 三个 target 构建并推送 GHCR 镜像。
2. Windows job 使用 Node.js 22、pnpm 和 frozen lockfile 安装依赖。
3. Windows job 执行 `pnpm desktop:package`。
4. `pnpm desktop:package` 进入 `@yunwu/desktop`，执行 `pnpm build && electron-builder --win zip`。
5. `electron-builder` 将 `dist/**/*` 和桌面 `package.json` 放进 asar，将 `../../infra` 与 `apps/desktop/resources` 作为 `extraResources` 放进 zip。
6. Release job 下载 Windows job 上传的 portable artifact，并通过 `softprops/action-gh-release` 上传到 GitHub Release。

`apps/desktop/package.json` 中的关键配置：

- `productName`: `Yunwu Desktop`
- `asar`: `true`
- `directories.output`: `release`
- `win.target`: `zip`
- `win.arch`: `x64`
- `win.artifactName`: `${productName}-${version}-win-${arch}-portable.${ext}`

远程 `v0.4.3` release 资产事实：

- 发布运行：Release workflow run `25253771840`
- tag commit：`6bd87f38942208f4b7edebdcf8a0b9490bc56004`
- GitHub asset：`Yunwu.Desktop-0.4.3-win-x64-portable.zip`
- size：`129490821`
- digest：`sha256:32985a2f145487c41f75387ff013e745203e0b40d3cad7888488501fd4f81970`

## 桌面运行策略

桌面壳启动后不在宿主机运行 Node 服务。它检查 Docker CLI/daemon，选择可用端口，写入 Electron `userData/runtime` 下的运行时文件，然后使用内置 Compose 文件拉起本地服务栈。

运行时文件：

- `.env`
- `docker-compose.override.yml`
- `identity.json`
- `desktop.log`

内置 Compose 文件顺序：

1. `infra/docker-compose.yml`
2. `infra/docker-compose.desktop.yml`
3. 运行时生成的 `docker-compose.override.yml`

release 模式：

- `app.isPackaged === true` 且没有 `YUNWU_DESKTOP_BUILD=1` 时，先执行 `docker compose pull`。
- `pull` 失败时记录日志并继续尝试本地已有镜像。
- 然后执行 `docker compose up -d`。
- 退出时执行当前实例的 `docker compose down`，保留数据卷。

开发模式：

- 非 packaged 或显式设置 `YUNWU_DESKTOP_BUILD=1` 时，执行 `docker compose up -d --build`。

`v0.4.3` 桌面运行时将镜像源写为：

```env
YUNWU_IMAGE_REGISTRY=ghcr.io/alterego-42
YUNWU_IMAGE_TAG=v0.4.3
```

注意：当前工作树如果已经修改 `infra/docker-compose.desktop.yml` 或桌面启动逻辑，恢复上一版策略时应以 `v0.4.3` tag 为准。

## 版本一致性检查

发布前应同步检查这些位置：

- 根 `package.json` 的 `version`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/desktop/package.json`
- `packages/shared/package.json`
- `apps/desktop/src/renderer/index.html` 中展示的桌面版本
- `apps/desktop/src/main/main.ts` 中写入运行时 `.env` 的 `YUNWU_IMAGE_TAG`
- `infra/docker-compose.desktop.yml` 中默认 `YUNWU_IMAGE_TAG`
- `.github/workflows/release.yml` 的 manual dispatch 默认版本
- `README.md` 当前推荐版本与使用说明
- `docs/release/vX.Y.Z.md`

推荐改进：后续不要继续手写多处版本字符串。桌面主进程应从 `app.getVersion()` 或打包时注入的常量读取当前版本，Compose 默认 tag 也应由 release workflow 或单一版本源生成。

## 账号系统策略

当前账号系统是本地数据库账号体系，不是 GitHub/GHCR 账号，也不是云端租户账号。Release 更新不应依赖用户登录态。

后端：

- `AuthModule` 注册全局 `APP_GUARD`，默认保护 `/api` 下非 `@Public()` 路由。
- `POST /api/auth/register` 创建普通 `member` 用户。
- `POST /api/auth/login` 登录已有用户。
- `GET /api/auth/me` 用于恢复会话；无效或过期 Cookie 会触发清理。
- `POST /api/auth/logout` 清理会话 Cookie。
- 密码使用 `argon2` hash。
- 会话是自签 `HttpOnly` Cookie，不使用第三方 JWT 库。
- Cookie payload 只包含 `userId`、`role`、`exp`。
- `SameSite=Lax`；`AUTH_COOKIE_SECURE=false` 时不加 `Secure`，本地桌面默认如此。
- API 启动时通过配置同步内建 `admin` 与 `demo` 账号到数据库。

角色：

- `admin`：可进入 `/admin`，后端 `@Roles("admin")` 路由只允许该角色。
- `demo`：保留为内建演示账号。后端多数业务查询按“非 admin”处理，因此数据仍按自己的 `userId` 隔离。
- `member`：普通注册用户。

数据边界：

- `User` 是账号根实体。
- `Conversation.userId` 必填，前台会话按用户隔离。
- `Task.userId`、`Asset.userId`、`Message.userId` 用于任务、资产和消息归属。
- 普通用户查询历史、作品库、任务、会话时必须带 `userId` 条件。
- `admin` 在部分查询中可跨用户查看，但删除作品库资产等用户侧行为仍按具体业务方法限制。
- `UserSettings` 按 `userId` 一对一保存用户自己的 provider base URL、provider API key、启用模型和 UI 配置。

安全注意：

- 当前 `provider_api_key` 以数据库字段保存，响应只返回 masked 状态。正式面向更多用户分发前，应评估本地数据库明文保存的风险，并考虑使用 OS credential store、加密列或至少明确告知本地数据边界。
- 桌面 `AUTH_SESSION_SECRET` 当前由运行时 `identity.json` 稳定生成，升级时必须保留 `userData`，否则所有用户需要重新登录。
- Release 更新会影响同一桌面实例下所有本地用户和服务容器，因此触发更新的 UI 应默认放在桌面壳或管理员入口，不应让普通用户无提示重启服务栈。

## 用户侧 release 更新方案

现状：`v0.4.3` 没有自动更新能力。用户升级方式是手动下载新的 GitHub Release portable zip；业务服务镜像标签由桌面运行时 `.env` 写死为当前版本。

推荐分三阶段实现。

### 阶段 1：更新检查与引导下载

目标：让用户知道有新版本，但不自动替换 portable 程序。

落位：

- Desktop 主进程负责检查 release。
- Desktop renderer 展示更新状态和按钮。
- 不依赖本地 Web 登录态。

实现：

1. 在 release workflow 中额外生成并上传 `latest.json`，或直接使用 GitHub Releases API 的 latest release。
2. Manifest 至少包含：

```json
{
  "version": "0.4.4",
  "tag": "v0.4.4",
  "channel": "stable",
  "releaseUrl": "https://github.com/Sou39O/Yunwu-custom-api/releases/tag/v0.4.4",
  "portableAsset": {
    "name": "Yunwu.Desktop-0.4.4-win-x64-portable.zip",
    "sha256": "..."
  },
  "images": {
    "api": "ghcr.io/alterego-42/yunwu-custom-api-api:v0.4.4",
    "worker": "ghcr.io/alterego-42/yunwu-custom-api-worker:v0.4.4",
    "web": "ghcr.io/alterego-42/yunwu-custom-api-web:v0.4.4"
  },
  "minDesktopVersion": "0.4.4",
  "requiresDesktopUpdate": true,
  "migrationRisk": "normal"
}
```

3. Desktop 主进程用 `app.getVersion()` 与 manifest 版本做 semver 比较。
4. 通过 preload 暴露 `desktop:get-update-status`、`desktop:check-updates`、`desktop:open-release-page`。
5. 桌面启动页和错误页展示“发现新版本”，按钮打开 release 页面。

这是 portable zip 下最稳妥的第一步，因为正在运行的 exe 不需要自我替换。

### 阶段 2：镜像栈更新

目标：当桌面壳兼容时，允许用户只更新 API/Worker/Web 镜像。

适用条件：

- Manifest 标记 `requiresDesktopUpdate=false`。
- `minDesktopVersion <= app.getVersion()`。
- Compose 文件和桌面 IPC 没有破坏性变更。
- 数据库迁移允许从当前版本前进。

实现：

1. 将当前选中的 image tag 保存到 `userData/runtime/release.json` 或运行时 `.env`，不要继续在每次启动时无条件覆盖为打包版本。
2. 更新前执行当前实例 `docker compose down`，保留 volume。
3. 写入新 `YUNWU_IMAGE_TAG`。
4. 执行 `docker compose pull`。
5. 执行 `docker compose up -d`。
6. 等待 API `/health`、`/readiness` 和 Web `/health`。
7. 成功后记录 `currentImageTag` 与更新时间。

风险控制：

- API 容器启动时会执行 `prisma migrate deploy`，数据库迁移通常不可自动回滚。
- 因此镜像栈更新必须有用户确认，文案说明数据卷会保留但迁移可能前进。
- 如果需要回退，只能在迁移兼容时切回旧镜像标签；不能承诺通用回滚。
- 更新动作会重启本地服务，应只放在桌面壳，或放在 `/admin` 且由后端 `@Roles("admin")` 保护。

### 阶段 3：桌面壳自动更新

portable zip 不适合作为全自动自替换载体。若需要真正的一键安装更新，推荐新增 Windows installer 发布目标：

- 保留 `zip` 作为便携包。
- 新增 `nsis` target。
- 使用 `electron-updater` + GitHub provider。
- release workflow 生成 `latest.yml`、安装器和 checksum。
- 安装器路径负责替换 Electron 壳，桌面退出前仍执行 `docker compose down` 并保留 volume。

如果必须继续只发 portable zip，也应使用外部 updater helper：

- 主进程下载 zip 到临时目录并校验 sha256。
- 写入待更新计划。
- 退出主程序。
- helper 停止 compose、备份当前程序目录、解压新 zip、重启新 exe。
- 失败时恢复备份。

这个方案复杂且 Windows 文件占用风险高，不建议作为第一版。

## 建议的实现清单

第一步只做检查与引导：

- 新增 release manifest 生成脚本，例如 `scripts/release/write-manifest.mjs`。
- Release workflow 上传 manifest 到 GitHub Release。
- Desktop 主进程新增更新检查服务，设置超时和失败降级。
- Preload 暴露最小 IPC，不暴露任意 URL 打开或文件系统写入能力。
- Desktop renderer 增加更新状态 UI。
- 增加 `pnpm --filter @yunwu/desktop typecheck` 覆盖。

第二步再做镜像栈更新：

- Desktop runtime 持久化当前 image tag。
- Compose 启动读取持久化 tag。
- 增加更新确认、pull/up 日志、健康检查和失败状态。
- 文档明确数据卷、迁移和回退限制。

第三步再评估 installer：

- 只有当用户确实需要一键替换桌面壳时，再引入 `nsis` 和 `electron-updater`。
- 不要为了普通业务镜像更新提前切换整个分发模型。

## 发布前验证

至少执行：

```powershell
pnpm --filter @yunwu/desktop typecheck
pnpm desktop:verify-release
pnpm --filter @yunwu/api test:auth
pnpm --filter @yunwu/web test:routes
```

如改动镜像栈更新逻辑，还需手动验证：

- Docker Desktop 未启动时的引导。
- 有旧 volume 时从旧 tag 升级到新 tag。
- API migration 成功。
- Web 能恢复登录态。
- 关闭桌面后当前实例容器被 `down`，volume 保留。
- 端口冲突时仍可重新探测并启动。
