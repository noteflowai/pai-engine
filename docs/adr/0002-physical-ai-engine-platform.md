# ADR 0002 · Physical AI 引擎平台：本体、引擎、决策模型与对外服务

状态：已采用（2026-10-10）。沿 ADR 0001（制品与流程）扩展，任务 `pai-artifact-platform-20261008`，逻辑角色 `pai-workbench`。

## 背景

用户要求把设计工作台升级为更大的 **Physical AI 引擎平台**，能对外提供服务；架构上引入**本体（ontology）**的最佳实践，并集成 AWS Strands Labs 开源的 **Strands Robots** 框架和 **Strands Decider 2B** 决策模型。

两点事实先于决策（2026-10-10 查官方仓库与发布文章）：

- **Strands Decider 2B 是 AWS Strands Labs 自己的开源决策模型**（2026-10-01 发布，Apache-2.0，基座 Qwen3.5-2B-Base + LoRA + 决策头）。**Jev 不是 AWS 的**：它是 TypeSafe AI 当月早些时候发布的同类闭源 API 模型；Decider 的服务接口按 Jev 公开文档的请求格式实现，但官方注明"与 Jev API 本身的兼容性未验证"。决策模型不生成文本，只在给定选项里选择、给是/否概率或打分，每个答案带校准过的置信度；官方明确它在复杂问题上远不如推理模型。
- **Strands Robots**（`strands-labs/robots`，Apache-2.0）：一个 `Robot()` 返回 MuJoCo 仿真（默认）或真机，150+ 机器人注册表，策略（LeRobot / GR00T / Cosmos 等）走同一个 `run_policy`；资产首次使用时从上游（MuJoCo Menagerie）克隆。

## 决策

### 1. 本体 `pai-ontology-1`：唯一的语义模型

采用运营本体的"对象 / 链接 / 动作"模式（Palantir Foundry Ontology 的做法），但**从已经强制执行的代码派生，不另写一份**（`src/ontology/model.ts`）：

| 元素 | 含义 | 来源与强制 |
|---|---|---|
| 对象类型（27） | 26 个存储的记录种类各对应一个对象类型，另加运行时计算的 `Engine` | 契约测试扫描全部存储种类，缺一个就失败；测试在任务、需求版本和计划的真实记录上核对声明的属性（原生记录尚未逐项覆盖） |
| 链接类型（31） | 记录真实携带的引用字段（`projectId`、`feedbackId`、`criteriaId` ……）；多态链接写明判别字段（`evidenceKind` → 记录类型） | 测试核对所有目标类型存在、判别字段是声明的属性，并在真实记录上解析链接 |
| 动作类型（46） | **写入只能经过动作**：每个写路由恰好对应一个动作，参数就是该路由解析请求体所用的同一个 Zod schema（导出为 JSON Schema；没有请求体的 4 个动作除外），标明效果（创建 / 转移 / 原生执行 / 核验 / 提议）、提交者（维护者 / 带 scope 的 Agent / 授权内自主）和是否启动原生工具 | 测试枚举服务器的全部写路由，新增路由没有动作类型就构建失败 |

标准词表**映射而不重造**：W3C PROV-O（实体 / 活动 / 计划 / 代理）、QUDT 单位、SHACL 形状；几何沿用 STEP、MJCF、OpenUSD。导出：`GET /api/v1/ontology`（JSON，带每个动作参数的 JSON Schema 和内容摘要）、`GET /api/v1/ontology.ttl`（OWL 2 类与对象属性 + SHACL 节点形状，Turtle）。对象读取：`GET /api/v1/objects/:type`（分页摘要）与 `GET /api/v1/objects/:type/:id`（对象 + 出入链接）。

**访问边界**：浏览器登录用户可读全部对象类型（制品文件的字节除外，它们只通过制品版本和签名包读取）。机器 Agent 用 read scope 只能读 `/api/agent/state` 已经提供的那些类型；试用观察（含参与者标识）、制品、流程和运行不对 Agent 开放。

**不引入图数据库**：SQLite + 导出的模式满足当前查询；只有出现真实的多跳图查询需求时再评估（Neptune / RDF 存储）。

### 2. 引擎即制品，`/api/v1/engines`

平台对外的基本单位是**引擎**（CadQuery/OCCT、CalculiX、OpenFOAM、MuJoCo、Blender、FreeCAD CAM、OR-Tools、Strands Robots、Strands Decider），统一报告名称、版本、固定点、是否可用、运行位置（本机 / AWS Batch）。引擎的结论规则不变：**结论只来自原生求解器与独立核验器**。逐步把各通道封装为 ADR 0001 的制品适配器（已有物流；其余通道按需迁移，不重写求解代码）。

### 3. Strands Decider：快速"系统一"层，只建议，不裁决

- **用途**：路由（规则解析不出计划时，建议交给哪个工具通道）与风险判断（请求是否在放宽要求）。答案、置信度、模型标识、阈值和延迟写入计划的回执。
- **边界**：Decider 的结论**永远不执行、不验收**。置信度 ≥ 0.9（官方评测：该区间约 95% 正确）才作为建议展示，仍需人确认；低于阈值或回答不在可选项内时不给建议，由人补充描述，或改用助手的 AI 引擎模式（大模型）。不自动转交。同一 `requestId` 重复提交直接返回已记录的计划，不再调用 Decider。验收仍只看原生检查。
- **实测（本机，2026-10-10）**：L40S GPU 中位延迟 202 ms；CPU 8 线程 11.3 s、2 线程 15.5 s，进程常驻 8.6 GB。本项目 18 条真实助手消息：Decider 与规则同为 72%；自编的 21 条留出集：Decider 100%，规则 52%（自编集有偏，不作为对外结论）。CPU 与 GPU 的 39 个选择完全一致，置信度最大差 0.012。
- **实测记录**：[decider-eval.json](../evidence/decider-eval.json)、[robots-crosscheck.json](../evidence/robots-crosscheck.json)，摘要见 [VERIFICATION.md](../VERIFICATION.md#引擎平台adr-0002)。
- **部署**：通过 `PAI_DECIDER_URL` 接入 Decider 自带的 `serve` 服务（`/v1/systemone`）。**托管站点（t3.medium，4 GB）跑不了**；需要 GPU 实例或独立服务，属于新增成本，等用户决定，托管上显示"未配置"。

### 4. Strands Robots：仿真引擎与官方模型交叉校验

- 以固定版本（`strands-robots==0.5.3`，哈希锁定）和**固定提交的 MuJoCo Menagerie**（离线缓存，运行时不联网）接入；`mode="real"`、mesh（Zenoh）和 `trust_remote_code` 在平台内**一律禁用**，沿用硬件三道闸。
- 第一个用途：把工作单元里的机械臂与官方 UR5e 模型交叉校验（关节、限位、正运动学、可达范围、质量），作为只读的交叉校验记录，与现有 Newton 交叉校验同一性质，不改变结论。实测发现：200 个固定种子的随机构型下法兰位置最大偏差 6.4 mm（限值 10 mm）；**我们的机械臂连杆总质量 29.0 kg，官方模型 17.0 kg**：原生单元的质量参数偏重。2026-10-11 已改为官方 UR5e 的连杆质量（共 16.99 kg），交叉校验 5 项全部一致；节拍与结论不变（基准 5.897 s、拒绝方案 4.598 s、修正方案 4.598 s），因为单元按位置控制，节拍由轨迹决定。
- 之后：策略回放（`run_policy`）的成功率作为新检查项（M7）。

### 5. 对外服务：分阶段，默认不开放

| 阶段 | 内容 | 状态 |
|---|---|---|
| 本体与引擎目录 | 本 ADR 第 1、2 节 | 本次实现 |
| 机器对机器 API | 沿用 Cognito client credentials 与 `/api/agent/*`（read / propose / run scope）；本体、引擎目录和对象读取加入 read scope | 本次实现 |
| 租户 | 每个租户一个 Cognito 客户端（只有 `pai-agent/tenant` scope），运行带租户标识并按它隔离；维护者把流程**提供**给指定租户（只能是全部制品已发布的流程），可撤销 | 已实现（`src/tenants.ts`）；默认没有租户 |
| 配额与计量 | 每租户并发运行数、24 小时运行数上限（超出返回 429，不留记录）；`pai-usage-1` 按租户汇总，未知量保持未知 | 已实现；成本上限与价格版本**未上线，不收费** |
| 邀请制内测 | 在部署 context 里加一个租户、提供一个流程即开始；合成或授权数据 | 机制已就绪；**第一个租户等用户指定** |

默认：**只邀请制**，先开放封装好的制品与流程，不开放任意原生引擎输入；不处理客户上传的未审数据前不放开。

### 6. 职责边界（不变）

PAI：领域产品、本体、引擎适配器、核验器与界面。noteflow-auto：调度、故障转移、账本与长任务。AgentForge：Agent 网关。Strands Agents SDK 与现有 AI 运行时重叠，**不替换**，需要时只作为一个新的引擎档案，由上述 owner 共同决定。

## 后果

- 新写路由必须先定义动作类型；新存储种类必须先定义对象类型；外部集成按本体的 JSON Schema / SHACL 对接。
- Decider 与 Strands Robots 都是可选引擎：没装就报告不可用，平台行为与之前一致。
- 托管站点不运行 Decider，直到有人批准 GPU 服务的成本。

## 改名（2026-10-11）

仓库从 `noteflowai/pai-design-workbench` 改为 `noteflowai/pai-engine`。GitHub 对旧地址的 git、网页和 raw 链接自动跳转（已实测）。**有意保留**的内部标识：npm 包名、CDK 栈 `PAIDesignWorkbench`、Cognito 用户池名、资源标签、MCP 服务名、systemd 服务名和本地账本路径。改这些会替换或断开在用的云资源与已签名记录，用户看不到它们，所以不改。

后续：本体从"旁边"移到核心，见 [ADR 0003](0003-ontology-kernel-plugins.md)。
