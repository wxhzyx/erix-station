# INTEVA Gitea 自动发布

入口为私有仓库 `SDA_IT/erix-station` 的 `main`，工作流 `.gitea/workflows/deploy.yml`。
GitHub 的原始 CI/tag 发布保留；内部上线只由本 Gitea 工作流负责。

## 触发与执行

推送或合并到 main 后自动执行；也可在 Actions 手动重跑 main。其他分支和 PR 不触发生产发布。
仓库专用 Runner `fde-station-10.13.16.45`，标签 `fde-station-release`，单并发，systemd 自动启动。
它只注册到本仓库，未注册到组织或全实例。仅仓库维护者可修改流水线；普通 FDE 不应拥有本仓库写权限。
2026-11-03 用户明确授权该 Runner 的 Docker 管理权限与固定发布助手 sudo 权限。
Host runner 不提供不可信代码隔离，不能给用户项目复用，也不能添加 fork/PR 执行触发器。

检出使用 Gitea 临时 job token 和服务器可达地址 `http://10.13.16.21:3300`，不持久保存 PAT。
每次运行创建独立工作目录。过期 main 提交在检出前跳过；执行期间使用文件锁避免重叠发布。
部署参数和服务凭据仍在 root-only `/opt/fde-station/deploy/.env`，不进入 Git 或镜像构建上下文。

流程为：

1. Linux 容器按三份 lockfile 安装依赖，语法检查、根/runner 单测、前端 typecheck/test/build。
2. 编译 portal、FDE runner、Docker admission proxy 三镜像，以提交 SHA 标记并记录不可变 image ID。
3. 检查活跃 run 与数据库 advisory lock。有人正在运行或操作时拒绝上线，待空闲后重跑。
4. 保存环境、Compose 和 PostgreSQL 逻辑备份；停止 portal，执行增量迁移。
5. 只替换本站 portal/proxy 镜像；FDE 镜像改变时重建对应容器，保留用户卷、项目、账号和网络。
6. 验证本机 health、`/version.json` 的提交 SHA、所有原有 FDE 的健康心跳及 HTTPS ingress。
7. 成功记录 `/var/lib/fde-station/current-release.json`；失败恢复旧镜像和配置，并验证恢复后健康。

数据库迁移必须是向后兼容的增量变更。回退应用时不自动恢复数据库备份，避免丢弃部署后用户数据。
已生成的镜像和发布记录保留供回退；不做全局 Docker prune 或删除其他业务镜像。

本服务器 Docker Hub 直连超时，内部构建使用官方 GHCR v0.1.47 的不可变基础镜像。
Linux 依赖仍按本次 lockfile 重新安装，前端重新编译，portal/runner/proxy 源码均来自本次 main SHA。
`runtime-contract.json` 钉住标准 Dockerfile 的运行环境契约；改变 SDK、系统包或运行环境时，
必须审查并更新专用 CI Dockerfile 的基础镜像及契约校验和，否则构建失败，不会沿用错误的旧环境上线。

## 主机文件

- `/usr/local/bin/fde-gitea-runner`：官方 Runner 二进制，下载后校验官方 SHA-256。
- `/var/lib/fde-ci/config.yaml`、`.runner`：专用执行器设置及注册凭据。
- `/var/lib/fde-ci/work`：独立构建目录；`npm-cache` 只缓存 npm 包。
- `/usr/local/sbin/fde-station-promote`：从 `deploy/ci/promote.py` 安装的 root-owned 助手。
- `/etc/sudoers.d/fde-station-ci`：只允许该助手；它校验工作目录范围、完整 SHA 和镜像 revision。
- `/var/lib/fde-station/releases/<时间>-<SHA>`：配置、数据库备份和发布清单，root-only。

发布助手是主机信任边界的一部分，修改 `promote.py` 后应由管理员审查并重新安装，不由流水线自我替换。
LiteLLM callback 运行在其他网关主机，本流水线不自动重启这些共享服务。
