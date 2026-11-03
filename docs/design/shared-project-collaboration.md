# 项目共享与协作开发方案

日期：2026-11-03。状态：共享项目、邀请、个人工作副本、Gitea 分支保护、真实 PR 审核合并及保留式删除已实现；验证和部署记录见 `docs/ops/shared-projects.md`。

## 1. 产品规则

管理员上传开发交付包并下发给负责人。负责人邀请平台内成员加入同一个项目；每个人在自己的工位目录开发、使用自己的模型 key 和额度，通过 Gitea 合并请求汇入项目主分支。普通成员不能自行创建项目，邀请也不等于创建一个无关联的新项目。

“个人工作树”在本方案中的产品含义是个人独立工作副本。Git worktree 是本地仓库机制，不是 Gitea 提供的远程工作空间；首版采用每人独立 clone + 个人分支，继续使用 `~/projects/<workspace>` 作为 agent cwd，不恢复已经废除的每次运行临时 worktree，不共享可写卷或 `.git` 目录。

用户界面显示 SSO 的域账号和显示名。内部主键、历史 fde_name、外部账号映射均不冒充用户名；改显示名不会改 UUID、重建仓库或重置用量。

## 2. 用户实际操作

1. 管理员：上传 ZIP → 指定负责人、项目名称和交付要求 → 下发。交付包可以含规范、需求、Agent 指令和调试资料，也可以含源码；不强制源码。
2. 系统：记录交付包哈希与版本，在受管项目组织中建立私有项目仓库，提交初始交付内容，设置分支保护，准备负责人的个人工作副本。
3. 负责人：项目卡片点击“成员” → 从已登录过 SSO 的平台成员中选择 → 发送站内邀请。只有负责人和管理员能邀请、撤销和转交负责人。
4. 被邀请者：在“待加入”中接受或拒绝；接受后异步准备 Git 权限、个人分支、目录。全部验证成功才显示“进入项目”。不把接受邀请与开通成功混为一谈。
5. 开发者：进入自己的目录，在个人分支开发；聊天、运行记录、附件和密钥仍属于本人。共享的是项目 Git 内容。
6. 开发者：点击“提交合并” → 查看变更、源分支/目标分支和提交 SHA → 创建 Gitea PR。AI 可提出审查建议，不能代替审核或静默合并。
7. 负责人或管理员：查看差异、检查结果和冲突 → 批准 → 合并。本人提交的 PR 必须由另一名审核人（必要时管理员）批准。
8. 其他成员：看到“主分支有更新”，主动同步；工作区有修改时先提示保留修改，不自动覆盖、不自动 rebase 正在执行的任务。

## 3. 界面结构

| 位置 | 必须呈现 | 操作 |
| --- | --- | --- |
| 我的项目 | 项目名、负责人、我的分支、开发状态 | 进入、提交合并、查看成员 |
| 待加入 | 项目名、邀请人、交付摘要 | 接受、拒绝 |
| 项目成员 | 域账号、SSO 姓名、角色、准备状态 | 邀请、移除、转交负责人（按权限） |
| 合并请求 | 提交人、源分支、变更摘要、检查/冲突/审核状态 | 看差异、退回、批准、合并 |
| 管理台项目 | 项目、负责人、成员数、交付包版本、仓库、状态 | 下发、管理成员、归档、删除工作空间 |
| 运行端口 | 域账号和姓名、项目、实际监听端口、监听状态、路由分配 | 搜索、刷新 |

运行端口只读真实心跳监听：45 秒内有效，15 秒刷新；预分配不等于监听，监听不等于 HTTP 健康。项目来自进程 cwd 根目录，不能由最近聊天、端口段或仓库名称猜测。显示不了就“未识别项目”。池外端口可列出但不生成直连地址。管理页不因管理员身份自动签发任何人的预览访问票。

## 4. 仓库、分支与权限

默认采用“一项目一个组织私有仓库 + 每成员一个个人开发分支”。示例：项目 `machine-dashboard`，`main` 为汇总分支，个人分支 `dev/JXu14`、`dev/employee`。分支标识创建后持久绑定成员 UUID；实际 Gitea login 按已验证账号映射，不拿 SSO 显示名拼 API 路径。非法字符与重名用确定性编码处理，界面仍显示真实账号。

不默认采用每人 fork：同一个公司内的协作，fork 会增加私有仓库复制、撤权与仓库归属迁移成本。组织仓库允许成员读取整个项目，这是“参与同一项目”的权限含义；如果将来要求成员互相看不到代码，必须拆仓库或交付不同项目，个人分支不是保密边界。

| 角色 | 项目管理 | Git 读取 | Git 推送 | 审核/合并 |
| --- | --- | --- | --- | --- |
| 平台管理员 | 下发、移交、归档、清理 | 按受管权限 | 管理服务专用凭据 | 可审；禁止自审合并 |
| 项目负责人 | 邀请、撤销、移交申请 | 全项目 | 仅本人开发分支 | 可审他人 PR |
| 协作者 | 接受/退出、本人工作空间 | 全项目 | 仅本人开发分支 | 提交 PR，不合并 |
| 被撤销/删除成员 | 无 | 撤销远程访问 | 无 | 保留历史署名 |

**强制在 Gitea 实现**，不能只隐藏按钮：

- `main` 禁止普通推送、force push、删除；PR 至少一名独立审核者；新提交使旧批准失效；拒绝审核、检查失败、目标分支过时均阻止合并；管理员也遵守保护规则。
- 每个 `dev/<member>` 配置精确保护规则：仅对应成员可正常推送，禁止其他协作者、force push 和删除。用全局默认保护规则拒绝未登记分支推送，再为成员分支设有明确优先级的允许规则，防止自行造分支绕过流程。必须实测规则优先级，不凭字段存在假定有效。
- 成员仅 repository write，不加入可管理所有仓库的组织 team，不给 repo admin。项目负责人在 FDE 的负责人权限不等于 Gitea 仓库管理员权限。
- 平台 Git 管理凭据仅在服务端；容器持有个人受限凭据，不能持有组织 token、LiteLLM master key 或 Docker socket。
- 个人凭据必须核查仓库范围：如果现有用户 token 能访问该用户全部仓库，明确它不是单项目 token。首版可以保留该个人凭据模式，但撤销成员必须删该仓库 collaborator 权限；不能声称跨项目凭据隔离已经完成。

现网只读检查：`/api/v1/version` 和 `/swagger.v1.json` 均报告 **28.2.0**。Swagger 提供 collaborator、branch_protections、pulls/merge 端点，并包含 `push_whitelist_usernames`、`enable_push_whitelist`、`priority`、`required_approvals`、`dismiss_stale_approvals`、`block_admin_merge_override`、`block_on_outdated_branch` 和 `status_check_contexts` 等字段。**这是接口存在性证据，不是行为验收**；实现前必须用专用临时仓库验证，不能拿网上文档版本号替代现场行为。

## 5. 数据模型与一致性

| 表/对象 | 核心字段与约束 |
| --- | --- |
| collaboration_projects | UUID、名称、owner_user_id、package_id/package_sha、Gitea repo_id/owner/name、default_branch、state、version、deleted_at |
| project_memberships | project_id + user_id 唯一；role=owner/member；state=invited/provisioning/active/revoking/revoked/failed；inviter、accepted_at、权限版本 |
| project_workspaces | membership_id 唯一；user_id、container_id、cwd、branch、base_sha、state、cleanup_at；用户+目录活跃唯一 |
| project_pull_requests | project_id、workspace_id、Gitea PR id/number、source_sha、target_sha、merge_sha、review state、checks、last_synced_at |
| project_operations | project_id/member_id、operation_key 唯一、step、attempt、last_error、next_retry_at；可恢复 outbox 作业 |
| project_audit | actor UUID、project UUID、member UUID、动作、SHA、结果；不含 token 和交付包全文 |

DB 保存平台权限与生命周期；Gitea 是仓库、提交、PR 和分支保护的事实来源。平台不得根据本地缓存宣布“已合并”。操作前重新查 Gitea，webhook 只作为唤醒信号；验签、delivery id 去重，并定期主动对账，防止漏 webhook 导致永久旧状态。

开通过程：`invited → provisioning → active`。依次检查用户有效、受管仓库、保护规则、分支与权限，最后准备目录并验证 remote/HEAD；任何一步失败为 failed，保留步骤重试。仓库创建使用稳定 project UUID 标记并回读 repo_id；不能仅按名字认领已有仓库。目录也必须包含 workspace/project/member 身份标记，不覆写同名旧目录。

撤权过程：先将 membership 置 revoking、拒绝新会话/运行/预览票 → 停止该项目活动任务 → 收回该仓库 Git 权限并独立读回 → 撤销该项目预览 grants → 清理该成员该项目目录（显式操作）→ revoked。某外部步骤失败保持 revoking/failed 并继续重试，不显示已完成。不能保证撤回用户已经下载到别处的代码。

邀请限额与防滥用：一成员一项目一条邀请，重复提交幂等；默认仅 active 平台用户；受邀用户仍需已有工位容量和模型权限，分享不能绕过管理员禁用、分配限制或每日 Token 上限。邀请不另送 200 万额度，同一个用户所有项目共用个人日额度。

## 6. 真实 Gitea PR 与发布

现有 `project-approvals.js` / `approval-git-merge.js` 流程在临时 bare repo 构造 merge commit 后直接 push，**没有真实 Gitea PR**，并且目前不支持 linked worktree。新增模式必须引入 Gitea PR adapter；不能把旧直接 push 包装成“PR 已合并”。旧审批记录只读保留，旧入口仍服务未迁移项目，新协作项目只能走新 adapter。

创建 PR 前确认 membership active、workspace 归属、真实 remote 的 repo_id、允许源分支、main 目标、无 secret。把准确 source SHA / target SHA 写入请求。审核绑定具体 SHA；提交追加或目标变更就废弃审批，重新获取差异/检查。合并前再读权限、PR 状态、head SHA、target SHA、冲突与检查，再调用 Gitea merge API。平台合并服务对每个项目串行加锁，main 的合并白名单仅含该服务身份；负责人在平台审核，不能另走直接推送绕开。若现网 API 无法原子约束所审 source/target SHA，必须借助服务器分支保护与唯一合并入口补齐，否则阻止上线，不能用“调用前查过一次”宣称无竞态。结果不明（超时）先查 PR 和 merge SHA，对账后才决定重试，禁止重复 push。

冲突在提交者自己的目录处理：先保护未提交修改，再 fetch/merge main，开发者确认并提交新 SHA，重新检查/审批。不会把冲突解决任务派到别人的目录，也不替用户选择冲突内容。

**执行不可信代码的 Runner 与发布 Runner 必须分离**：

- PR 检查运行在无宿主 Docker、无 sudo、无生产 secrets、无共享可写缓存的临时环境。构建脚本本身也是不可信输入。
- 现有 FDE Station 平台发布 Runner 有 Docker/root 发布能力，只允许平台私有仓库受保护 main 的发布，不用于用户项目 PR 或任意交付包代码。
- 协作项目合并 main 后仅产生受控构建结果；是否发布、发布到哪里由管理员为该项目指定发布配置。不能把“合并代码”默认等同“获得平台服务器发布权”。
- 工作流、依赖安装脚本、Dockerfile、部署脚本等敏感文件更改需要管理员审核，主分支保护及组织权限共同限制绕过；供应链构建仍需要隔离，单纯 codeowners 不等于沙箱。

## 7. 删除与保留边界

| 操作 | 清理范围 | 必须保留 |
| --- | --- | --- |
| 移除项目成员/本人退出 | 该项目权限、该项目任务和目录（明确确认后） | 其他项目、个人工位容器、远端提交/PR、历史用量 |
| 删除个人交付工作空间 | 此 workspace 的目录、会话归档、预览授权 | 团队主仓库、其他成员目录、Gitea 历史、LiteLLM 历史 |
| 管理员删除整个共享项目工作空间 | 全体成员在此项目的目录/会话/任务/授权 | 组织仓库改为归档/保留、PR、审计、历史用量 |
| 删除平台成员 | 该用户全部工位容器、停用个人模型 key、禁用 Git 登录 | Gitea 成果和署名、用量记录、别人的容器及目录 |

共享项目不拥有独立个人容器：一人可能在同一工位跑多个项目，不能删除一个项目就删整台容器。负责人离开/被删除前将项目移交管理员接管；禁止产生无负责人活跃项目。单个项目撤权不能封禁整个 Gitea 账号或封禁全局 LiteLLM key。平台删除用户保留现有 tombstone/外部历史策略。任何删除不自动删除远端仓库；远端永久删除不在此功能范围。

## 8. 现有项目迁移

当前 `project_assignments` 是“一个用户一份交付”，仓库可能归个人所有，不能直接当共享项目：个人 repo owner 可绕过分支保护/改权限。新下发项目进入受管组织；旧项目先只读盘点 remote repo_id、owner、HEAD、保护规则、本地脏文件、活动任务、交付标记和凭据。

迁移采用显式维护作业：暂停该项目新任务 → 记录备份与 SHA → 将实际仓库转移至受管组织（保持提交历史）或在无法转移时建立受管 canonical 镜像并保留原仓库 → 验证保护规则与权限 → 更新 DB 映射和本人 origin → 恢复。转移会改变仓库归属和 URL，实施时单独展示准确对象和影响，不能后台静默批量改用户仓库。

旧的无 repo_url、无目录标记或已有同名不同仓库的交付留为“待关联”，不猜测、不覆盖。旧 project_assignments.id 和删除历史保留，通过 nullable collaboration_project_id 逐项关联。迁移失败时保留原仓库/目录和恢复指针，不在失败补偿中删除任何用户 Git 成果。

## 9. 实施顺序与验收

1. **仓库权限探针**：临时私有仓库 + 两个专用测试账号，验证组织所有权、精确分支优先级、禁止主分支直推/force push/删除、不能写他人分支、不可新建绕过分支、自审不能合并、管理员保护、撤权生效。任何一项不满足，阻止协作上线；必要时改为服务端受限 Git 写入代理或私有 fork 并重新评审权限。
2. **项目与成员模型**：增量迁移、邀请/接受/撤销 API、基于 UUID 的权限校验、outbox 幂等和崩溃恢复；现有交付与个人项目保持兼容。
3. **个人工作空间**：由受控 runner 初始化 clone/branch，项目级锁保护目录；上报新 workspace 归属，不让 API 依赖客户端提交 cwd 来授权。
4. **真实 PR adapter**：创建、差异、检查、审核、合并、webhook 与定时对账；替换协作项目直接 push 路径。
5. **UI 与试点**：一个项目两名真实受邀成员，各自提交/预览，跨用户访问应拒绝；真实合并后主仓库 SHA 与平台显示一致。
6. **迁移与发布**：完成一个存量项目演练，再逐项迁移；每项保留回退记录。

| 验收场景 | 必须观察到的结果 |
| --- | --- |
| A 邀请 B、B 重复接受 | 一条 membership、一个目录、一个个人分支；A/B 使用各自模型 key |
| A/B 同时开发 | 文件、进程、聊天、Token 分别归本人；共享仓库的权限符合表格 |
| B 请求他人 workspace id/cwd | 服务端 403，不能借项目成员关系读他人个人文件 |
| 主分支直推/他人分支推送/force push | Gitea 拒绝，非仅页面禁用 |
| PR 批准后再推一个提交 | 旧批准失效，不能直接合并 |
| 两个 PR 同时合并/有冲突 | 目标 SHA 检查生效，过期一个重新审核，无覆盖 |
| 接受邀请中途服务重启 | 从已完成步骤恢复，无重复仓库、无覆盖目录 |
| 撤权时还有活动任务或 Git 网络失败 | 先拒绝新任务，状态显示处理中/失败，重试可完成 |
| 删除 B 或删除 B 的项目目录 | A 的容器/代码保留；B 远端提交、PR、旧 Token 用量可查 |
| malicious PR 修改工作流/安装脚本 | 无生产凭据/宿主 Docker，不能触发高权限发布 |
| 心跳停止/刷新失败 | 45 秒后不再标监听中；空状态与错误能区分 |

建议结论：方案可行，但真正的工作量在 Gitea 权限强制执行、PR 竞态、撤权和存量仓库归属迁移，不是增加一个“分享”按钮。没有上述探针和两人端到端证据之前，不应宣布协作已上线。

## 10. 参考

- Git worktree 官方说明：https://git-scm.com/docs/git-worktree
- Gitea 分支保护：https://docs.gitea.com/usage/access-control/protected-branches/
- Gitea Actions token 权限：https://docs.gitea.com/usage/actions/token-permissions/
- 现网 API：`http://10.13.16.21:3300/swagger.v1.json`（2026-11-03 只读核对）
- 现有实现：`project-approvals.md`、`portal/src/managed-projects.js`、`portal/src/project-approvals.js`、`portal/src/approval-git-merge.js`。
