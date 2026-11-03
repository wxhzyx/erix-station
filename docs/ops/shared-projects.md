# 共享项目运行与验收

版本：0.1.51。入口：顶部「项目协作」，管理员通过「项目交付」上传 ZIP 并下发。新下发默认使用共享项目；未配置协作服务的部署保留原下发方式。PR 作者与审核人显示保留的 SSO 姓名，Gitea 原始作者身份不改写。

## 配置与权限

`FDE_COLLAB_CONFIG_FILE` 指向只读挂载、root-only JSON 文件，字段为 `baseUrl`、`organization`、`login`、`token`。专用非站点管理员账号拥有私有项目组织，PAT 仅配置 `write:repository`、`write:organization`、`read:user`。不得把该文件挂入工位、放进交付包或提交仓库。个人工作副本的 origin 不含 token，模型仍走原个人 key 和日额度。

默认拒绝规则 `**` priority=100，个人分支 priority=10，main priority=1。准备分支时仅服务账号可初始化；准备完成后只有成员本人可推送。main 禁止直推和 force push，至少一位当前负责人/平台管理员批准，提交更新废弃旧审批，目标过时拒绝合并，仅服务账号可调用合并。平台合并在项目 advisory lock 中执行，源 SHA 通过 Gitea `head_commit_id` 校验，审批还绑定当前 main SHA。

受管仓库关闭 Actions，**不会执行共享项目代码或自动部署共享项目**。平台现有高权限发布 Runner 仍只用于平台自身仓库。若项目另接外部检查，已上报的失败/等待状态会阻止合并；没有配置检查时不宣称 CI 已通过。部署目标与隔离检查 Runner 是另行配置项。

## 生命周期

- 邀请仅面向已开通工位且在同一 Gitea 的有效用户。本人接受后准备个人 clone 和 `dev/<域账号>` 分支，重复接受幂等。拒绝/移除后可重新邀请，复用分支历史并重新准备目录。
- `collaboration_projects`、`project_memberships` 的持久状态就是待执行队列，15 秒循环恢复 provisioning/failed/revoking/deleting；不依赖内存任务。目录身份标记和稳定仓库 UUID 防止接管同名资源。按项目锁串行处理外部副作用。
- 成员工作副本暂存和删除隔离目录放在 `<users>/<fde>/.collaboration-staging` / `.deleted-projects`，与 `home`、`projects` 同级且不挂入工位。必须继承该成员的 XFS project ID；即使 `st_dev` 相同，跨配额 ID 的目录 rename 也会返回 `EXDEV`。旧交付暂存目录同样位于成员根目录。
- 真实 Gitea PR 在每次打开和操作时回读；不把 DB 中的批准当作已合并。审批 SHA 落 `collaboration_reviews`，动作写 `audit_log`。首版采用请求时回读加生命周期轮询，无 webhook 依赖。
- 同步主分支按钮只在自己的工作台预填任务，用户确认后执行；不静默覆盖未提交修改，不自动发送模型请求。
- 移除成员先禁用该项目任务、归档会话并撤销相关预览票，然后撤 Git collaborator 权限。已有任务正常停止并提交终态用量后，工位心跳清理实际 cwd 属于该项目的后台进程；下一次观察不到进程才 ACK。随后只清理该项目目录。旧 runner 未支持 ACK 时保持清理中，不能伪报完成。
- 删除平台成员时先把其负责的共享项目交给操作管理员，再走现有停用 key、Git 登录和全部容器下线流程。远端仓库、PR、提交署名、模型用量不删除。
- 删除整个共享项目后所有成员分支和 main 均禁止写入/合并，远端仓库及 PR 保留可查。

**现网兼容决定**：Gitea 28.2.0 设置 `archived=true` 后，已存在 PR 的 GET API 返回 404；恢复 false 后原 PR/合并 SHA 完整可读。因此这里使用平台归档 + Gitea 全分支写入关闭，保留 `archived=false` 与 PR 单元。不是删除或重建仓库。已归档项目管理员仍可查看历史 PR。

旧 `project_assignments` 通过 nullable `collaboration_project_id` 区分。已有个人仓库和未关联目录不会自动迁移、改 origin 或转移归属；旧审批记录保留。协作项目明确拒绝旧的直接 push 合并入口。迁移一个旧项目仍须先盘点实际 remote、脏文件和活动任务并指定对象，不猜测无 remote 的项目。

## 验收

`node --test portal/test/collaboration.test.js runner/test/project-cleanup.test.js` 覆盖权限默认拒绝、分支规则回读、凭据错误脱敏、本人接受边界、工位清理 UID/cwd 范围和失败不 ACK。

`scripts/acceptance/shared-projects.mjs` 是显式运行的真实 PostgreSQL/Gitea 集成验收。需提供专用测试账号文件（JSON 数组，每项 login/token）、测试 ZIP、服务配置文件，通过 `FDE_COLLAB_ACCEPTANCE_FIXTURES`、`FDE_COLLAB_ACCEPTANCE_PACKAGE`、`FDE_COLLAB_ACCEPTANCE_CONFIG` 注入。在服务器配置上下文执行，创建独立 schema 和 `/tmp/collab_qa_*` 工作目录，不改已有用户项目。测试包括重复接受、中断重试、非成员拒绝、旧审批失效、真实 PR 合并、撤权失败后重试、重新邀请、删除后 main SHA/PR 保留。测试 schema 留作诊断，测试账号用后停用，远端验收成果保留。

发布必须经过私有仓库 main 流水线，检查版本与 revision、迁移 0032、工位新 runner 心跳、认证 UI 及真实业务操作；HTTP 200 或镜像构建成功不能代替协作验收。
