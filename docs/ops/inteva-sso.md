# INTEVA SSO 与自动开户

配置 `OIDC_ISSUER` 后登录页显示 INTEVA SSO 入口。INTEVA 部署设置 `OIDC_ONLY=1`，
只显示 SSO 按钮，关闭密码、TOTP 和旧版密码登录入口；未开启该选项的其他部署保留本地登录。
采用 OIDC Authorization Code + PKCE S256，openid-client 验证签名、issuer、audience、nonce。
回调的 state 在数据库保存哈希，绑定 HttpOnly 浏览器 cookie，五分钟过期且只消费一次。
UserInfo 的 subject 必须与 ID Token 一致。

## 配置

在 INTEVA_SSO 注册独立 confidential web client `fde-station`，授权码模式、强制 PKCE，
scope 为 `openid profile email`，回调 `https://fs.5195746.xyz/api/auth/sso/callback`。
生产 issuer 为 `https://cnsda-app106.intevaproducts.com:8088/`。
现有 SSO 的用户启停、锁定和客户端许可继续生效；本系统不修改其他 SSO 客户端。
企业 CA 通过 `NODE_EXTRA_CA_CERTS` 挂载，禁止关闭 TLS 校验。

部署环境变量：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI`、
`OIDC_GIT_HOST_ID`、`OIDC_LLM_PROVIDER_ID`、`OIDC_LLM_MODEL_ID`。
可选 `OIDC_ADMIN_SUBJECTS` 为明确授权的 SSO subject 逗号列表；默认所有新用户为普通 FDE。
本部署管理员为用户指定的 `JXu14`（SSO 返回的实际大小写），其他身份不提权。
凭据只放部署服务器 root 可读文件，不进入仓库。

## 身份与资源

首次登录按 `issuer|sub` 建档，用户名/工位名为 `sso-<规范化sub>-<身份哈希>`。
不会通过相似用户名或邮箱自动关联本地账号；不会依据上游 role claim 提升管理员。
同一身份并发登录由数据库事务锁串行化。重复登录复用账号、Git 账号及 LiteLLM key，
已停用工位不会因再次登录自动启用。

首次建档在同一事务中写入现有 onboarding 队列：Gitea 账号与最小 Git token →
工位容器/配置 → LiteLLM 用户及专用虚拟 key。进度及失败保存在 DB，使用已有管理员重试流程。
SSO 首次开户遇到 Gitea 同名账号会拒绝并要求管理员核实，不重置无关联的现有账号密码。
工位中的 Git 凭据由平台注入；自动创建账号不等于给人分发 Gitea 网页登录密码。

部署服务器通过 `http://10.13.16.21:3300` 访问 Gitea；办公网络对应地址为
`http://10.13.25.26:3300`。平台管理员凭据不下发给工位容器。

公司 LiteLLM `10.13.16.166:4000` 为统一入口，FDE Station team 隔离模型目录与成员。
每次 SSO 登录幂等同步 `fde-<平台用户UUID>` 与 team member，不更改既有人员的管理员权限。
工作和聊天分别使用虚拟 key，metadata 的 `fde_id` 相同，合并计入个人每日额度；key 白名单只包含所选模型。
默认 Qwen 路由为 `fde-station-qwen3.8-flash-next`；外部模型 `fde-station-deepseek-flash`
明确选择后经内网 LiteLLM → 移动云专用中转 key → DeepSeek 官方。没有从 Qwen 自动回退到外网的规则。
Traefik 按来源工位网段注入该用户 key，用户容器不持有上游 key 或网关管理 key。
重复登录不轮换 key，历史用量可继续按 user/key 查询。
管理连接使用可撤销的专用 key，限制为开户、key 生命周期和模型目录读取接口；不复制网关 master key。
团队配置变量为 `LLM_GATEWAY_TEAM_ID`；网关 URL、管理 key 与自动开户默认模型必须一起切换。
配额及交付包见 [托管项目与每日配额](../design/managed-delivery-quota.md)。

## 验证与边界

2026-11-02：`JXu14` 已完成真实 SSO 登录并创建管理员工位。两个独立测试身份自动开户成功，
Gitea 私有仓库创建和推送成功，移动云两枚虚拟 key 均产生独立 spend。
真实 agent run `b1fc3f37-66ee-477e-b723-e62ba36a7657` 读取 Gitea 仓库并写入验收文件，状态 finished。
跨用户读取会话返回 404，工位访问宿主 SSH/portal 端口与其他工位被防火墙阻断。
LiteLLM 当前费用按其模型成本表统计，峰谷与缓存计费的最终账单以 DeepSeek 为准。

执行 OIDC/Git 单测、前端类型检查与测试；部署后验证 discovery、登录跳转、回调防重放、
两个测试身份独立开户、不同 key、真实模型调用及各 key 的用量记录。
自动化内部开户探针不能替代真实员工在 SSO 页面登录的验收。
平台退出目前只撤销平台 session，尚未实现 SSO 全局单点退出或已登录 session 的即时目录撤销。
