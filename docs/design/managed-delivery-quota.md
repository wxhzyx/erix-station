# INTEVA 托管项目与每日 Token 配额

2026-11-02/03 用户明确授权的部署扩展。开发交付包可仅含需求、规范、AGENTS、示例配置和调试资料；不要求提供源代码。

## 管理员下发

`MANAGED_PROJECTS=1` 时普通用户没有项目创建入口，服务端创建会话前检查本人 `ready` 分配记录。
管理员上传 ZIP → 选接收人、交付包、项目名和补充要求 → 创建该用户 Gitea 私有仓库并初始化项目。
用户之后可在项目中自由开发。现有项目和仓库不会被下发覆盖，失败可重试。

这是用户明确要求的受限 Git 写入例外：仅在平台私有临时目录初始化本次分配的新仓库；
不读取用户工作区 Git 配置，不执行 hooks，不重置已有用户项目，不接管同名无关联仓库。
完整交付包是本次 Git 初始提交的内容，模板 `.gitignore` 不会漏掉初始交付资料。
后续工作区 Git 操作仍由用户/agent 完成。管理员批准合并流程沿用聊天/工作模式分支的独立审批设计。

ZIP 限制：压缩 50 MiB、展开 150 MiB、2000 条目、单文件 50 MiB；拒绝路径穿越、`.git`、符号链接、
特殊文件、加密条目和大小写重名。共同包装目录自动去掉。不可变归档、SHA-256、清单和分配状态存 DB。
临时区不挂给 FDE，最终通过原子 rename 发布，文件属主为 worker UID。Gitea 凭据不写入项目或日志。
只有归档能保证恢复完整交付资料，因此数据库备份须与用户卷、Gitea 仓库一起保留。

## 个人额度

默认每天 2,000,000 输入＋输出 Token，北京时间 00:00 按日切换。
聊天和工作 key 共享平台用户 UUID；管理员可以直接设置个人上限（0 禁用），普通用户只能申请提高。
申请在 DB 保存，管理员批准/拒绝有审计记录；批准不会降低另一管理员已经调高的额度。

LiteLLM 扩展 `deploy/litellm/fde_quota.py` 在请求进入上游前预留保守输入估计和最大输出，SQLite WAL
事务串行化额度扣减，完成时按上游实际 `total_tokens` 结算，重复回调不重复收费。流式完成回调同样结算。
没有可靠 usage 的失败/断线请求保留预留额度，直到下一天；页面区分已用和调用中预留。
当前接入为文本聊天，支持字符串及 text blocks；图片/音频不在该额度组件支持范围。

组件仅适用于单网关主机（允许多个进程），数据库目录必须持久挂载 `/var/lib/fde-quota`。
多机水平扩展前必须换成共享事务存储，不能让每台机使用独立 SQLite 配额。
配额管理员密钥 `FDE_QUOTA_ADMIN_KEY` 与网关 master key 分离，门户端不可把此密钥交给浏览器或 FDE。
额度 API 失败时请求/审批报错，不假装成功；网关组件故障不得通过移除 callback 放行绕过额度。

内网部署设置 `FDE_QUOTA_TEAM_ID`，只处理 FDE Station team；其他公司模型业务不参与本次计数。
移动云专用上联 key 的服务端 metadata 标记 `fde_station_uplink=true`，额度已在内网记账，云端不重复扣。
用户请求中的 metadata 不能覆盖服务器绑定的 `fde_id`。

## 接口与迁移

- 用户：`GET/POST /api/me/token-quota`。
- 管理员：`GET/PUT /api/admin/users/:id/token-quota`、`GET /api/admin/token-quota-requests`、`POST /api/admin/token-quota-requests/:id/review`。
- 管理员：`GET/POST /api/admin/delivery-packages`、`GET/POST /api/admin/assigned-projects`、`POST /api/admin/assigned-projects/:id/retry`。
- 网关私有管理：`GET/PUT /fde-station/quota/:userUUID`。

生产已执行的 `0026-oidc-login-states.sql` 不改名、不改校验和；新增交付/申请表为 0027。
合入分支的 mode-settings/chat-mode/project-approvals 迁移顺延到 0028/0029/0030。
部署前备份 DB 与环境配置。回退旧镜像保留新增表，禁止清空人员、项目或用量数据。


## 删除与历史保留

管理员可分别删除成员与下发项目，使用迁移 `0031-retained-deletions.sql` 保存删除标记。

- 删除成员：立即禁用登录，异步按工位归属标签与部署栈校验并删除全部容器（包括停止的和未登记的容器）。失败可重试，清理完成后从成员列表移除；用户 UUID、关联记录和审计保留，不允许自动重新激活。
- 个人 LiteLLM key 使用 `/key/block` 冻结，保留网关 key/user、历史调用和每日用量；不执行 `/key/delete` 或用户删除。平台撤掉可用绑定与路由。
- Gitea 仅禁止自动开户账号继续登录、移除平台凭据，不删除账号或仓库、分支和提交。
- 删除项目：`DELETE /api/admin/assigned-projects/:id`，JSON `confirmation` 必须等于项目名。只归档该项目会话、清理匹配下发标记的本地目录；不停止共享工位容器，不触碰其他项目，不请求 Gitea 删除。
- 仍有执行中/排队中任务时返回 409，先停止该项目再删；建会话、发送消息与删除共用成员项目锁，禁止清理期间新建任务。
- 删除标记先提交，目录移到成员挂载范围之外再清理，失败显示“重试删除”。保留下发记录及仓库地址用于审计；同名项目不自动覆盖历史仓库，重新下发请使用新项目名。
- 本地未推送修改会随项目目录清理而丢失，确认界面明确告知。成员目录默认仍按已有保留策略处理，容器删除不擦除 Gitea 或 LiteLLM 数据。
