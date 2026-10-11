# AWS 部署：pai.oneai.host

部署目标是 WordPress 已使用的东京区域 `ap-northeast-1`与已授权的私有 VPC/ALB。域名现有 CNAME 已指向该 ALB，HTTPS 使用现有 `*.oneai.host` 证书。本仓库只添加优先级 120 的主机路由，不修改 WordPress 的 100/110 路由、默认响应、HTTP 跳转或共享空闲超时。

前一轮（2026-10-01）已完成 0.2.1 更新和实际复核，入口为 [https://pai.oneai.host](https://pai.oneai.host)。管理员账号从私人登录回执读取，密码通过下述 `login-file` 命令读取至私人文件。当时发布摘要为 `3709ae89f38115ee7507a9fab74773b7ba9f2e67156e6bf1aea4b9dbd74002d9`，对应主分支提交 `a4035871abb5c9065f409cd4cce1c9983d79a80e`（0.3.0：需求版本、发布成熟度关卡、候选对比与状态栏）。实时 SSE 每 15 秒心跳，无需修改共享 ALB 的 60 秒空闲超时。[实际验收](VERIFICATION.md#021-发布与云端复核2026-10-01)包含 Cognito、1024/1280/1440px 桌面与 390px 手机、WordPress 200、四条路由摘要不变、原有 47 条文档记录及四份 STEP 的持久化。部署期间另有外部维护者新增一个任务；复核 48 条记录时，原有 47 条逐行汇总摘要完全相同。旧发布保留；快照恢复仍未演练。

当前维护者演示发布已于 2026-10-01 07:45 UTC 更新为摘要 `90362101b08799f7c66be0df3c44a15c3e67c9c594c2cb28a687d4599e038437`，源码为 `858d7c91666c943edc722fde9a67f22e58fb5f3c`（0.3.0，加原生 CAD 包围盒修正）。完整 CI 通过后才切换；实例、持久卷、VPC 与共享 ALB 不变。切换前没有活跃原生任务，原有 67 条记录与 18 份 STEP 摘要完整保留。真实 Cognito 登录、60×30×50 mm 精确名义包络边界、STEP 下载哈希、390px 手机及 WordPress 200 均通过，四条 ALB 路由摘要不变。此前发布目录保留；未重置预算或自动重放任务。[机器可读维护者验收](evidence/cad-bounds-cloud-acceptance.json)不计为独立试用或物理验证；没有包含 Kiro 尚未发布的 AI 引擎代码。

## 运行架构

```text
浏览器 → 现有 ALB HTTPS → Cognito 登录 → 独立 EC2 工作台
                                     ├─ Node 24.21 LTS + Blender 5.2.2 LTS + CadQuery 2.8
                                     ├─ AI：NoteFlow 执行器 ec007f0 + Kiro CLI 2.24.0（主→备→二备）
                                     ├─ 加密 gp3 持久化卷：SQLite、原生文件与回执
                                     └─ AWS Backup：每日快照，保留 14 天
```

独立 `t3.medium`（2 vCPU / 4 GiB）运行单个工作台，持久化卷 40 GiB，系统卷 16 GiB。只有现有 ALB 安全组可以访问 4317，未开放 SSH；运维通过 SSM。实例公网地址仅用于出站安装和 AWS/登录签名公钥访问，不作为用户入口。

Cognito 禁止自助注册，初始管理员由私人配置指定；初始化使用 `MessageAction=SUPPRESS`，不会发送邮件或邀请。密码由 Secrets Manager 生成并保存于 `pai-workbench/admin`，不进入代码、实例环境或文档。应用用 `aws-jwt-verify` 验证 ALB 签名、签发者、客户端、过期时间和主体，拒绝只伪造身份头的请求。生产 Origin 精确限定为 `https://pai.oneai.host`。

长原生任务返回 `202`、`Location` 和稳定任务身份，浏览器轮询原回执。重复请求不重新执行，重启后运行中任务保留为 interrupted。此机制避免修改共享 ALB 的 60 秒空闲超时。

## 可复核部署

基础设施位于 [infra](../infra)。公开模板不保存运维资源标识。先把本环境已核对的 `vpcId`、`subnetId`、`availabilityZone`、`routeTableId`、`amiId`、`listenerArn`、`albArn` 和 `albSecurityGroupId` 放入被 Git 忽略的 `infra/cdk.context.json`（JSON 对象，权限 0600），或通过 CDK 的 `--context key=value` 明确传入。缺少必需 context 时合成会停止。该私人文件不得提交、截图或用于公开文章；实际部署仍须既有授权与 diff 复核。AMI 默认值固定到本次核对的 Ubuntu 24.04 amd64 发行版，可通过 CloudFormation 参数覆盖；AMI 升级可能替换实例，需要维护窗口和数据卷恢复流程。

```bash
npm ci
npm run check
npm run test:native
npm run test:browser
python3 tools/package_release.py
cd infra
npm ci
npm run synth
npm run diff -- --no-change-set
npm run deploy -- PAIDesignWorkbench
# 回到仓库根目录；新版本通过受控 SSM 切换
cd ..
python3 tools/aws_operator.py apply-release
```

运行版本：打包时写入 `.build-info.json`（`package.json` 版本、源提交、打包时间）。登录后每个页面左上角（品牌旁）显示 `v<版本> · <短提交>`（悬停看完整提交与发布包摘要），也可读 `GET /api/version`（需要登录）；`apply-release` 成功时同样输出版本和提交。短提交与 `origin/main` 一致即为最新发布。`/healthz` 不返回版本。

部署包使用显式文件白名单，不包括 `.state`、数据库、提示词、私人控制器、浏览器会话或本地生成的证据。S3 上传包、Node 和 Blender 下载均验证 SHA-256。实例安装固定版本的公开依赖，不初始化模型预算账本。

管理员凭据与 SSM 运维使用该项目的最小范围 operator role：

```bash
python3 tools/aws_operator.py status
python3 tools/aws_operator.py login-file
```

第二条只将凭据写入被 Git 忽略的 `.state/deploy/admin-login.json`，权限为 0600；终端不打印密码。`send --script /path/to/reviewed-script.sh` 与 `result --command-id ID` 可用于明确授权的实例检查。不要在检查脚本中打印凭据。

在托管实例上复跑某个端到端脚本（服务用户、服务环境与原生工具、临时状态目录，不碰线上数据）：

```bash
PAI_SEND_E2E=pillow-e2e python3 tools/aws_operator.py send --script tools/hosted_e2e.sh   # 也可以是 fea-e2e、cad-e2e 等
python3 tools/aws_operator.py result --command-id <ID>
```

只读的界面验收：`node scripts/hosted-ui-check.mjs <输出目录>`（用 `.state/deploy/admin-login.json` 登录，逐页截图并检查 390 px 溢出，不修改任何数据）。

`PAI_SEND_*` 环境变量会加引号后传给脚本。脚本直接用 Node 的类型擦除运行发布包里的 `dist/src`；成功时输出脚本写下的证据报告（每份一行 JSON），失败时输出日志末尾，退出码与脚本相同。

### 登录回调返回 401

`/oauth2/idpresponse` 由 ALB 自己处理。开始登录时 ALB 写入 `AWSALBAuthNonce` cookie（约 15 分钟有效），回调时核对它；cookie 过期、缺失或被另一次登录覆盖时，ALB 返回 `401 Authorization Required`，工作台收不到这个请求。常见原因：登录页停留超过 15 分钟；在另一个标签页或窗口又开始了一次登录；刷新或恢复了带 `code=` 的回调地址（授权码只能用一次）；在已安装的应用和浏览器之间切换。处理：直接打开 `https://pai.oneai.host/` 重新登录，不要重开回调地址。2026-10-08 用真实管理员账号复核，新开的登录流程 302 → Cognito → 回调 302 → 200，正常。

界面在会话过期（1 小时）后的 API 请求会被 ALB 重定向到 Cognito；页面会自动整页重新加载并重新登录，被重定向的请求不会到达服务器，也不会重放。

**已定位并修复的根因（2026-10-09）**：只要浏览器里注册着工作台的 service worker，退出登录后重新输入密码登录，回调必然返回 401。在真实站点上用管理员账号可稳定复现：登录 → 清除全部 cookie → 重新登录 → `401`。注册着 worker 时，浏览器会在登录导航之外再发一个指向 `/` 的后台请求；ALB 对它也下发一个新的 `AWSALBAuthNonce`，覆盖了正在进行的这次登录的 nonce，回调核对失败。对照实验：阻止 service worker 时登录成功；只让 worker 放过页面导航时仍然 401；worker 注销后登录成功。修复办法是不再注册 service worker，`/sw.js` 换成自注销脚本，旧浏览器下次访问时会自动删除旧 worker 和它的缓存，页面加载时也会主动注销。代价是没有离线外壳；工作台本来就不在离线时排队执行任何命令。

## AI 引擎

托管站点只启用 Kiro 主账号、备用账号和二备账号。Codex 依赖个人登录，Claude 需要额外的 Bedrock 授权，所以都不在托管端启用。

- **密钥。** 三个密钥保存在 Secrets Manager 的 `pai-workbench/kiro-keys`。实例角色只能读取；运维角色只能写入和描述，通过 `python3 tools/aws_operator.py put-ai-keys` 从本机密钥文件上传，终端不显示任何值。
- **执行器源码。** 按固定提交打包成单独的 S3 资产（`ExecutorKey`），不进入 Git，也不进入发布包。
- **发布时的安装。** `infra/install_ai.sh` 以 `pai` 用户身份执行：
  - 校验 SHA-256 后安装 Kiro 和执行器；
  - 把密钥写成仅属主可读写（0600）的文件；
  - 按 `tools/ai-ledger-policy.json` 创建独立账本（只限尝试次数：每天 20 次，单次运行最多 5 次，Kiro 12 次，不设金额上限）。已有账本只复用，不替换也不重置；
  - 写入 systemd drop-in。
- **沙箱。** 服务单元使用 `ProtectSystem=strict`，Kiro 和 acpx 的状态目录 `~/.kiro`、`~/.acpx`、`~/.cache`、`~/.local` 单独设为可写，存放凭据的 `~/.config` 对服务保持只读。
- **出错时。** 引擎回执显示 `work_started=false`、`effects=unknown` 时，界面要求人工核对，不会自动重放。

Claude 引擎（`claude` profile）走 Amazon Bedrock：`claude-agent-acp` 只继承进程环境，不读 `~/.claude/settings.json`。设置 `PAI_CLAUDE_BEDROCK_REGION`（如 `us-east-1`），工作台只把 `CLAUDE_CODE_USE_BEDROCK=1` 和 `AWS_REGION` 传给执行器进程，工作台自己的 KMS / S3 客户端不受影响；凭据来自 AWS 默认凭据链（托管站点是实例角色，只允许调用 Anthropic 模型和推理配置），不写入文件。用 `npm run probe:engine`（`PROBE_PROFILE=claude`）花 1 次账本确认可用。

Codex 引擎同样走 Bedrock：服务用户的 `~/.codex/config.toml` 只写 `model_provider = "amazon-bedrock-runtime"` 和区域，模型由执行器 pin 经 `CODEX_CONFIG` 指定。Bedrock 的 OpenAI 兼容 Responses 接口按账号的 `project/default` 鉴权，所以实例角色除了 `openai.*` 模型和推理配置，还需要该项目资源的 `bedrock:InvokeModel*`。

## 生成代码沙箱

发布脚本会安装 bubblewrap，并加载 `infra/apparmor-bwrap`。这是 Ubuntu 24.04 推荐的按应用授权配置：只给 `/usr/bin/bwrap` 开放非特权用户命名空间，系统级限制保持开启。沙箱内部仍然丢弃全部特权、不能联网。服务启动时会做一次探测，不通过就禁用该通道，见 [CAD_CODE.md](CAD_CODE.md)。

## Amazon Bedrock AgentCore

沙箱和执行 Agent 的 arm64 运行时部署在两个独立的栈 `PAIAgentCoreBase` 和 `PAIAgentCoreRuntime` 中，使用专用 VPC，不改动 WordPress 所在的 VPC 和工作台栈。托管站点目前仍在主机上本地运行这两项；如果要改用 AgentCore，需要给实例角色增加 `bedrock-agentcore:InvokeAgentRuntime` 权限并设置两个 ARN。详见 [AGENTCORE.md](AGENTCORE.md)。

### AgentCore 上的 Codex 与 Claude（Bedrock，执行角色）

AgentCore agent 运行时用执行角色的短期凭证调用 Bedrock（microVM 提供 IMDS 兼容的凭证端点，两个适配器的 AWS 默认凭证链都能找到），不存 Bedrock API key。权限与托管实例同一来源（`infra/bedrock.ts`）：只允许 `anthropic.*`、`openai.*` 模型与推理配置，加上 Codex Responses 接口需要的 `project/default`。区域等设置只在 `tools/bedrock-engines.json` 一处，`tools/bedrock_engines.py` 生成镜像里的 `~/.codex/config.toml`（只有 provider 与区域）；Claude 的 Bedrock 路由只传给执行器进程。

运行时提供的引擎 = `PAI_AI_PROFILES` ∩ 该运行时账本策略里配置的引擎。账本策略只增不减（noteflow-agent-control #154）：`op extend-ledger` 把现有账本扩展到 `tools/agentcore-ledger-policy.json`（新增引擎或收紧限额；放宽、删除或改映射会被拒绝），变更写入账本的策略历史，不新建账本。`probe` 返回 `enabledProfiles` 和 `bedrockEngines`（适配器在 arm64 镜像里启动并建立会话，不调用模型、不占账本）。

Codex / Claude 的回答按执行器规则总是"影响未知"。维护者在工作台记录核对结果时，工作台调用执行器 `reconcile`（本机）或运行时的 `op reconcile`（AgentCore）：执行器核对回执、写不可改的核对文件并结清自己的账本；回执不满足条件（对话被截断、有工具活动等）就保持待核对。

## 持久化与更新

数据位于 `/var/lib/pai/data/state`，单进程 SQLite WAL 数据库及同一卷上的原生文件共同快照。删除栈保留数据卷、备份 vault、登录用户池和管理员 Secret。运行实例的 systemd 服务失败后重启，并保留任务身份；EC2 状态与 ALB 不健康目标有 CloudWatch 告警，未配置外发通知。

后续应用升级先验证并打包，再部署 CDK 中新的发布对象和精确 S3 读取授权，随后执行 `python3 tools/aws_operator.py apply-release`。脚本验证 SHA-256，在独立目录安装依赖、停止服务、原子切换 `/opt/pai/current` 并复核健康；失败时自动切回旧目录，不覆盖数据库或原生回执。原生工具版本更新另需重新验证和显式安装。

本环境的初始启动包固定在 `infra/cdk.json` 的 `bootstrapReleaseHash` / `bootstrapAssetKey`，不要随应用发布修改它们，也不要删除对应 S3 对象。这样前端更新不会因 EC2 UserData 变化而停止或替换实例；当前发布包由 `ReleaseHash` / `ReleaseKey` 输出指定。新建其他环境应选择经过验证的初始包。AMI/实例替换必须先确认备份，并在同一可用区重新连接保留卷；不要并发挂载 SQLite 卷。

目前是单实例、单管理工作区，没有高可用或用户间数据隔离。后续多人试用需要独立工作区授权。新增费用主要是 EC2、公网 IPv4、EBS、快照和少量 Cognito 用量；复用既有 ALB，无新增 ALB 或 NAT 网关费用。

当前最新 CDK 2.271.0 捆绑的开发依赖 `brace-expansion` 5.0.9 有已知 DoS 公告，`npm audit fix` 无法修改厂商捆绑包。它只参与本地受控路径的模板构建，不包含在生产发布包中；已保留此上游限制，后续 CDK 更新需要重新检查。应用依赖安装审计未报告漏洞。

## Release signing and runtime pins (2026-10-03)

- **Release signing:** each approved release can be downloaded as a signed package (`GET /api/releases/:id/package`). The package contains the evidence record, every native file whose digest is in the record, the release decision, and a manifest signed by the KMS key `alias/pai-workbench/release-signing` (ECC_NIST_P256, ECDSA_SHA_256). The private key never leaves KMS, and the instance role can only call `Sign` and `GetPublicKey`. Verify offline with `npm run verify:package -- package.json key.pem`; the public key comes from `GET /api/signing/public-key`. A package is reported as trusted only when its signing key matches the key you pass in.
- **Runtime pins:** `tools/runtime-pins.json` records only the executor commit and its archive digest. The Kiro CLI version, the Kiro archive digests and the npm adapters are pinned inside the executor. The installer reads them from there and creates stable `executor` and `kiro` links, so the Dockerfiles and the service unit never name a version. Node comes from the same pins file.

## 邀请租户（ADR 0002 §5）

1. 在 `infra/cdk.context.json` 加 `"tenants": "[{\"id\":\"<租户>\",\"maxConcurrentRuns\":2,\"maxRunsPerDay\":50}]"`，`npm run diff` 应只新增该租户的 Cognito 客户端与密钥，并修改 Agent 路由的 ALB 规则（ALB 的 single-string 声明只能有一个值，所以有租户时 ALB 只校验签名、签发者和 token_use，由工作台逐请求校验精确的 client id、scope 与租户）；然后部署并执行 `apply-release`（把输出 `Tenants` 写进 `PAI_TENANTS`）。
2. 维护者在 `POST /api/v1/offerings` 把一个**全部制品已发布**的流程提供给该租户。
3. 运维者读取 `TenantSecretArn<租户>` 的密钥，经安全渠道交给租户；租户用 client credentials（scope `pai-agent/tenant`）调用 `/api/agent/v1/tenant/...`。
4. 结束：撤销提供；从 context 删除租户并部署会删除它的客户端和密钥。

不收费：用量只记录（`pai-usage-1`），没有价格版本。

