# PAI Engine

[![Workbench checks](https://github.com/noteflowai/pai-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/noteflowai/pai-engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**面向物理世界的可信决策引擎：以本体统一工业语义，以原生求解器裁决，以签名证据交付。**

工业里的 AI 难以落地，难点不在于模型会不会提方案，而在于没有人能为它签字：方案依据的是哪一版需求，物理上成不成立，谁批准的，事后能不能复核。PAI Engine 回答的就是这个问题。设计、仿真、制造和运营决策（零件、产线、机器人单元、场地与物流）在这里都表达为同一个**本体**里的对象、关系和动作；模型（Kiro、Codex、Claude、Strands Decider）只能提议或建议，结论只来自原生求解器（CAD/OCCT、FEA、CFD、MuJoCo、CAM、OR-Tools）和独立核验器，需求变更、验收和发布只能由人做；每个被采用的结果都带着冻结的需求版本、求解器回执和 KMS 签名，可以离线复核。

| 核心价值 | 做法 |
|---|---|
| **一个语义模型，贯穿全链路** | 本体 `pai-ontology-1` 是平台唯一的领域模型：对象类型就是存储的记录种类，链接是记录真实携带的引用，**动作是唯一的写入方式**；路由、权限（维护者 / Agent scope / 租户）、Agent 与租户可见范围都从它派生，契约测试保证模型与代码不会漂移。导出 JSON Schema 与 OWL 2 + SHACL（映射 W3C PROV-O），外部系统按同一套语义对接 |
| **AI 提议，物理裁决** | 每个引擎在目录里声明权限：只有原生求解器能给出结论，交叉校验引擎（Newton、Strands Robots）只给一致性记录，模型只给建议。学习型结构代理模型只看几何，给出挠度、应力和带区间的预测（常驻推理，托管实测一次约 90 ms，含特征提取），用来排序和筛选；推荐点必须由 CalculiX 实测复核，预测与实测的误差随记录保存 |
| **可复核的证据，而不是截图** | 结论绑定冻结的需求摘要、求解器版本与源码摘要、逐项检查；发布包 KMS 签名并加 RFC 3161 时间戳，在另一个环境可以离线核验并复现 |
| **决策算法即制品** | 优化与决策算法（车辆路径、场地准入与排队调度等）以不可变、自带验收基准的制品交付，用 JSON 流程组合，人工确认节点把关，按租户隔离运行并记录用量 |
| **不确定就停下** | 结果未知的原生或模型运行等人工核对，不自动重试；仿真结果始终标注为仿真，不冒充物理验证 |

托管实例：<https://pai.oneai.host>（登录可见；页面左上角显示运行的版本，悬停可见提交与发布包摘要）。仓库原名 `pai-design-workbench`，2026-10-11 改名，旧地址自动跳转。

[![机器人工作单元提速：MuJoCo 发现碰撞、AI 修正、CalculiX 否决几何最优、物理寻优、KMS 签名发布](docs/media/physics-demo.gif)](docs/DEMOS.md)

## 平台

```mermaid
flowchart LR
  subgraph Clients["入口"]
    UI["工作台 UI（Web / PWA / 桌面）"]
    Agent["外部 Agent（MCP / AgentForge）"]
    Tenant["邀请制租户（OAuth）"]
  end
  subgraph Core["PAI Engine"]
    Onto["本体 pai-ontology-1<br/>对象 · 链接 · 动作"]
    Life["设计生命周期<br/>需求 → 验证 → 反馈 → 发布"]
    Art["制品库与流程编排"]
  end
  subgraph Engines["引擎（按权限分级）"]
    V["结论：CadQuery/OCCT · CalculiX · OpenFOAM · MuJoCo · Blender · FreeCAD CAM · OR-Tools"]
    C["一致性：Newton · Strands Robots"]
    S["建议：Strands Decider 2B · LLM"]
  end
  Clients --> Core --> Engines
  Core --> Seal["签名证据（AWS KMS · RFC 3161）"]
```

| 层 | 说明 |
|---|---|
| **本体** | `pai-ontology-1`：29 个对象类型、32 个链接类型、50 个动作类型，从代码派生，契约测试防漂移；写入只能经过动作；导出 JSON Schema 与 OWL 2 + SHACL（PROV-O）。见 [ADR 0002](docs/adr/0002-physical-ai-engine-platform.md) |
| **引擎目录** | `GET /api/v1/engines`：每个引擎声明权限，只有 `verdict` 引擎能决定结论 |
| **设计工作台** | 平台上的第一个产品：需求冻结 → 候选设计 → 原生验证 → 失败回放 → 反馈复测 → 准入与签名发布 |
| **制品与流程** | 不可变、自带验收基准的算法/模型版本（第一个：场外物流规划，OR-Tools），JSON 配置的业务流程，逐节点证据与用量。见 [ADR 0001](docs/adr/0001-artifacts-and-workflows.md) |
| **对外服务** | 邀请制租户：维护者按邮箱邀请成员（Cognito 发出登录地址、用户名和临时密码，首次登录设新密码），也可给机器客户端开 OAuth；角色默认拒绝，成员只看到提供给本租户的流程，撤销即时生效；维护者把**全部制品已发布**的流程提供给指定租户；运行按租户隔离，并发与日上限，用量按租户汇总。**不收费**。见 [API](docs/API.md#tenants-v1-invite-only) |

## 部署架构

```mermaid
flowchart TB
  subgraph L1["① 入口"]
    direction LR
    User(["用户<br/>浏览器 · PWA · 桌面"]):::client
    Agent(["外部 Agent · 租户<br/>OAuth client credentials"]):::client
    ALB["Application Load Balancer<br/>精确 HTTPS Origin · JWT 校验"]:::edge
    Cog["Amazon Cognito<br/>OIDC"]:::edge
    User --> ALB
    Agent --> ALB
    ALB <-.-> Cog
  end

  subgraph L2["② 计算节点：EC2 g6.xlarge · NVIDIA L4（同一套镜像可换成 EKS 集群）"]
    direction TB
    Kernel["<b>PAI Engine 内核</b><br/>本体 · 动作 · 生命周期 · 引擎运行时（足迹检查）<br/><i>EC2：systemd 服务 · EKS：Deployment</i>"]:::core
    subgraph RUN["一次性引擎容器（无网络 · 只读根）<br/><i>Podman ⇄ EKS Job</i>"]
      direction LR
      CAD["CadQuery · OCCT<br/>AI 代码 → gVisor"]:::engine
      PHY["MuJoCo · Gmsh<br/>CalculiX · BoTorch"]:::engine
      ORT["OR-Tools<br/>制品"]:::engine
      BLD["Blender Cycles<br/>GPU · OptiX"]:::gpu
      RBT["Strands Robots<br/>Newton · GPU · Warp"]:::gpu
    end
    Decider["Strands Decider 2B<br/>系统一分诊 · GPU · 127.0.0.1<br/><i>EKS：GPU 节点组</i>"]:::gpu
    EBS[("加密 EBS 100 GiB<br/>SQLite · 回执 · 账本<br/><i>EKS：PVC</i>")]:::data
    Kernel --> RUN
    Kernel --> Decider
    Kernel --> EBS
  end

  subgraph L3["③ AWS 托管服务"]
    direction LR
    Batch["AWS Batch · Fargate<br/>FEA · OpenFOAM · FreeCAD CAM"]:::engine
    Bedrock["Amazon Bedrock · Kiro<br/>AI 引擎（系统二）"]:::ai
    KMS["AWS KMS + RFC 3161<br/>发布签名"]:::sec
    ECR[("Amazon ECR<br/>按摘要固定 · 扫描 · 签名")]:::data
    Ops["Secrets Manager · SSM<br/>AWS Backup 每日"]:::sec
  end

  ALB ==>|"仅 ALB 安全组 → :4317"| Kernel
  Kernel -->|"重计算"| Batch
  Kernel -->|"提议"| Bedrock
  Kernel -->|"封存"| KMS
  ECR -. 镜像 .-> RUN
  ECR -. 镜像 .-> Batch

  classDef client fill:#f8fafc,stroke:#64748b,color:#0f172a
  classDef edge fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef core fill:#0f766e,stroke:#115e59,color:#ffffff
  classDef gpu fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef engine fill:#ecfeff,stroke:#0891b2,color:#164e63
  classDef data fill:#fef9c3,stroke:#ca8a04,color:#713f12
  classDef sec fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef ai fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  style L1 fill:#ffffff,stroke:#cbd5e1
  style L2 fill:#f0fdfa,stroke:#0f766e,stroke-width:2px
  style L3 fill:#ffffff,stroke:#cbd5e1
  style RUN fill:#ffffff,stroke:#0891b2,stroke-dasharray: 4 3
```

- **一个内核，三种后端**：所有原生引擎都经过引擎运行时执行，调用时声明要读写哪些文件，运行前强制检查。后端可以是本机进程、容器或 AWS Batch，换后端不改变计算内容。见 [ADR 0004](docs/adr/0004-engine-runtime-containers-gpu.md)。
- **GPU 只用在不改变裁决数值的地方**：Decider 分诊、Blender 渲染、Newton 交叉校验。MuJoCo、CalculiX、OCCT、OR-Tools 和 OpenFOAM 的结论保持在 CPU 上计算，便于复现。
- **EC2 或 EKS**：同一套镜像和引擎运行时，可以从单台 GPU EC2 换到 EKS：
  - 内核改为 Deployment；
  - Decider 部署到带 NVIDIA device plugin 的 GPU 节点组；
  - 每次引擎运行改为一个 Kubernetes Job，模型写的代码用 gVisor RuntimeClass 隔离；
  - 数据卷改为 PVC。
  
  ALB、Cognito、Batch 和 KMS 不变。
- **现状（2026-10-11）**：
  - 已上线：托管站点运行在 g6.xlarge 上；OR-Tools、CadQuery、CalculiX/Gmsh/MuJoCo、Blender（OptiX）、Newton（CUDA）都在一次性 rootless 引擎容器里运行，镜像按摘要固定、推送即扫描；Decider 在 GPU 上运行；FEA 寻优、CFD 和 CAM 在 Batch 容器里运行。
  - Strands Robots 与 Decider 也已容器化；托管端到端 13 个核心脚本与外部租户流程全部通过（[回执](docs/evidence/hosted-e2e.json)）。
  - 有意未做：模型写的代码不换 gVisor（rootless 只有测试模式），镜像签名需账号级 ECR 配置批准；原因见 ADR 0004。
  - EKS 是已设计好的替换路径，目前没有部署。

## 能力

| 方面 | 实现（只写跑过的结果） | 文档 |
|---|---|---|
| 几何 | CadQuery 2.8 / OCCT 7.9，两个零件族：NEMA 17 电机支架与 6202 轴承座（Ø35 H7 轴承孔、止口、射线实测壁厚、M8 地脚）；两者都可用参数预设或由 AI 写 CadQuery 代码（三层沙箱，或 AgentCore microVM），由同一套 B-Rep 检查裁决；另有 Ahmed 型车身 | [CAD_CODE.md](docs/CAD_CODE.md) |
| 结构 | Gmsh C3D10 + CalculiX 2.21，两级网格收敛；电机支架按皮带载荷算挠度和应力，轴承座按轴承余弦载荷再加测受载轴承孔失圆（底座减到 6 mm 时几何检查全过，但被 CalculiX 否决）；可在 AWS Batch 上运行（每个点一个作业，核对摘要和版本） | [PHYSICS.md](docs/PHYSICS.md) |
| 流体 | OpenFOAM v2512（固定 digest 的官方镜像）：snappyHexMesh 两级网格 + simpleFoam k-ω SST；托管站点经 Batch 运行（16 vCPU，9 分钟） | [AERO.md](docs/AERO.md) |
| 优化 | 设计空间扫描与物理寻优两个零件族都可用：GP + NSGA-II、BoTorch qLogNEHVI（支架，配对比较）；代理模型只排序，用求解数据集预热（46.3 → 44.1 g）；轴承座以受载失圆为约束，7 个实测点中最轻可行 155.3 g（参考件 189.6 g），本机或 AWS Batch 求解；推荐点必须实测并正式复核 | [PHYSICS.md](docs/PHYSICS.md) |
| 机器人 | MuJoCo 工作单元（IK、500 Hz 动力学、碰撞、节拍、10 个种子配对）；CAD 零件装到机械臂末端；导出 MJCF 和 OpenUSD（28 个 UsdValidation 校验器；Newton 1.6 交叉校验关节树、质量和正运动学） | [PHYSICS.md](docs/PHYSICS.md) |
| 产线与场景 | Blender 5.2：工作单元与 6 工位产线，BVH 射线实测通道、围栏、相机覆盖 | [PLANT.md](docs/PLANT.md) |
| 可制造性 | 三轴铣削 DFM：最少装夹方向、钻孔通道、孔深径比、紧固件可装配性（DFA）、单件成本估算；CAM：FreeCAD 1.1 + OpenCAMLib 按装夹出 G-code，另一个独立进程在 0.1 mm 高度图上仿真，检查过切、残料、过载和快移碰撞，给出节拍和仿真图；托管站点上两者各自是一个 AWS Batch 作业（一次评审 11 分钟） | [CAM.md](docs/CAM.md) |
| 结构代理模型 | 学习型代理模型作为制品交付：训练数据是 AWS Batch 上 CalculiX 实测的 257 个设计点，模型是只看几何的 PointNet 集成（不用配方参数），带共形 90% 区间和域外标记。验收门槛事先确定，在留出集上重算。支架版（40 个留出件）挠度误差中位数 2.1%、应力 2.3%，轴承座版（42 个）1.2%、1.9%；配方以外的零件误差明显变大（实测一例挠度 18.7%，仍在区间内）；CAD 评审中先预测、后实测对比，只记录不裁决 | [ADR 0001](docs/adr/0001-artifacts-and-workflows.md#第三类制品结构代理模型-structural-surrogate-2026-10-13kind--model) |
| 证据 | EvalArc 基准对照、发布准入 5 项；AWS KMS 签名，加 RFC 3161 时间戳，只封存一次；界面内和离线核验；首件检验：按冻结公差生成检验计划，可导入 CMM 的 QIF 3.0 / CSV 报告，实测值逐项判定，随发布签名（唯一带 `physicalMeasurement: true` 的记录） | [VERIFICATION.md](docs/VERIFICATION.md) |
| AI | 受控执行器调用 Kiro（主账号 → 备用 → 二备，版本由执行器固定）、Codex 与 Claude（两者都走 Amazon Bedrock，托管站点用实例角色、不存密钥），共享账本、不自动重试，模型版本按固定 pin 核对；计划带收紧/放宽标记，确认后才执行；模型的物理估算由求解器打分；"带图问 AI"把已记录的渲染图、相机视图和应力云图按摘要发给模型（本机、托管站点和 AgentCore 均可用；盲测 6/6 与射线检查一致）；"AI 战绩"按 AI 记录被执行提案的求解器判定、人工修改、放宽尝试和估算偏差，并回传给模型用于下一次提案；模型同时能看到寻优点、FEA、DFM/CAM 和首件实测 | [AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md) |
| 自主 | 维护者在总览的"AI 自主迭代"卡片里签发授权（工具、次数、有效期）、给出目标，autopilot 多轮执行"提议 → 原生检查 → 修改"；执行器无法确认副作用时停下等人核对，核对后在同一授权内继续；外部 Agent 用 `pai_run_plan` 在同一授权内触发求解。实跑：Codex 为轴承座提出参数化修正，原生检查通过（150.654 g，见 [VERIFICATION.md](docs/VERIFICATION.md)）；所有冻结要求（外形、载荷、DFM、CAM 节拍）都参与放宽判断，不能放宽要求、验收或发布 | [INDUSTRY_BENCHMARK.md](docs/INDUSTRY_BENCHMARK.md) |
| 本体与引擎 | `pai-ontology-1`：29 个对象类型、32 个链接类型、50 个动作类型，写入只能经过动作；JSON 与 OWL/SHACL 导出，对象可按链接双向读取；引擎目录标明每个引擎的权限（结论 / 一致性 / 建议）。Strands Robots 对照官方 UR5e：200 个构型法兰最大偏差 6.4 mm，据此把单元连杆质量改为官方值（29.0 → 16.99 kg，节拍与结论不变）。Strands Decider 2B 在规则解析不出工具时给出带置信度的建议（L40S 约 200 ms），只建议、不执行 | [ADR 0002](docs/adr/0002-physical-ai-engine-platform.md) · [API](docs/API.md#ontology-and-engines-v1) |
| 外部 Agent | AgentForge 会话经治理 MCP 网关使用 11 个工具（读取、提议、求解数据集、授权内执行）；工作台 `integrations/agentforge` 是唯一来源，底座用一个摘要安装 | [integrations/agentforge](integrations/agentforge/README.md) |
| 制品（场地准入调度） | 场地有限时哪些车入场、何时入场、上哪个月台、何时离场：OR-Tools CP-SAT（门岗、堆场车位、月台匹配、班组、时间窗），独立核验器按分钟重算；高峰 40 车：入场 15 车、优先级分 34，先到先服务 11 车、17 分。合成场地，不放行真实车辆 | [ADR 0001](docs/adr/0001-artifacts-and-workflows.md#第二个制品场地准入与排队调度-yard-admission2026-10-11) · [VERIFICATION](docs/VERIFICATION.md#场地准入调度2026-10-11) |
| 制品（物流规划） | OR-Tools 取送货车辆路径，独立核验器只用标准库：验收基准 24 单 / 5 车，OR-Tools 3 车 698 km 全部分配，顺序启发式 5 车 1538 km 漏 2 单；新环境只拿签名包、重新验收后复现相同路线。合成数据，不派车、不声称最优 | [ADR 0001](docs/adr/0001-artifacts-and-workflows.md) · [VERIFICATION](docs/VERIFICATION.md#制品平台) |
| 界面 | 响应式 Web/PWA 与 Electron 桌面版；三维视口实时显示构建；失败检查旁"问 AI"；Ctrl+K 命令面板与任务搜索；深浅色；全部页面通过 WCAG 2.1 AA；[31 个典型工业用例](docs/INDUSTRIAL_TEST_CASES.md)覆盖全部通道 | [UI_UX_BENCHMARK](docs/UI_UX_BENCHMARK.md) |

## 演示

六段真实录制的成片：机器人工作单元提速（A）、AI + Blender 产线（B）、生成式 CAD（C）、从设计到车间（D）、AI 设计轴承座（E）、场外物流孪生（F，见下）。完整讲解、回执与下载见 [docs/DEMOS.md](docs/DEMOS.md)。

| A · 机器人工作单元 | B · 产线布局 | D · 设计到车间 | E · AI 设计，求解器裁决 |
|---|---|---|---|
| [![A](docs/media/physics-demo.gif)](docs/media/physics-demo.mp4) | [![B](docs/media/factory-demo.gif)](docs/media/factory-demo.mp4) | [![D](docs/media/cam-demo.gif)](docs/media/cam-demo.mp4) | [![E](docs/media/ai-demo.gif)](docs/media/ai-demo.mp4) |

### 场外物流孪生：传感器触发的实时决策

[![场外物流孪生：同一天、同样的扰动，先到先服务与 PAI Engine CP-SAT 并排运行](docs/media/yard-twin.gif)](docs/media/yard-twin.mp4)

场地、门岗、堆场车位、月台、作业班组、车辆与货物、传感器（门岗车牌识别、月台门磁、堆场占用）都是 PAI 本体里的对象。孪生（`native/yard_twin.py`）按分钟推进同一个合成工作日，并注入扰动：3 辆车晚到（门岗摄像头在时间窗开始时没看到车牌），D4 月台停用 30 分钟（门磁报警）。左边按先到先服务处理；右边由场地准入制品（OR-Tools CP-SAT）在开班时排一次，之后每次传感器报出新情况就重排：已进场的车保持不动，其余车重新决定。每一份被采用的方案都先经独立核验器检查。动画每一帧都来自这次运行记录下的方案，没有手工摆的画面。

| 同一天（24 车，3 辆晚到，D4 停用 30 min） | 先到先服务 | PAI Engine · CP-SAT |
|---|---|---|
| 入场车辆 | 16 | **24** |
| 被拒入场 | 8 | **0** |
| 优先级分 | 24 | **38** |
| 冷链作业 | 4 | **5** |
| 平均在场时间 | 102.8 min | **66.0 min** |
| 传感器触发重排 | — | 4 次 |
| 最终方案独立核验 | 通过 | 通过 |

CP-SAT 的总等待时间更长（545 vs 432 min），因为它多接了 8 辆车，而先到先服务直接拒绝了它们。复现：`npm run demo:yard-twin`（回执 [yard-twin.json](docs/evidence/yard-twin.json)），`npm run test:yard` 每次都在 CI 里重跑这个孪生。

### 场外物流决策：场地准入与排队调度

一个空间有限的场地，40 辆车在 90 分钟内陆续到达：每辆车有到达时间窗、货型和车长；场地有 2 条门岗车道、10 个堆场车位、6 个货型和车长各不相同的月台、3 组作业班组。下图是两种决策方式在同一合成实例上的结果，两份方案都经独立核验器按分钟重算通过：

![场地准入调度：OR-Tools CP-SAT 与先到先服务在同一高峰实例上的月台甘特图和堆场占用](docs/media/yard-demo.svg)

| 高峰 40 车（种子 7） | 入场车辆 | 优先级分 | 总等待 | 独立核验 |
|---|---|---|---|---|
| OR-Tools CP-SAT | 15 | 34 | 258 min | 通过 |
| 先到先服务（基线） | 11 | 17 | 359 min | 通过 |

先到先服务让早到的长作业车占住月台和车位，后面的冷链、高优先级车只能被拒；CP-SAT 在同样的门岗、车位和班组约束下重新安排入场和月台，同时把等待压下来。放不下的车会被明确列为"本时段不安排"，不会被硬塞进去；在预算内给出的是最好解，并如实标出"未证明最优"。复现：`npm run setup:logistics && npm run test:yard`。

## 快速启动

需要 Node.js ≥ 24.21、Python 3.12、Git；Linux x86_64 可以一键安装原生工具。

```bash
npm ci && npm run setup:demo
npm run setup:native    # Blender 5.2.2 LTS（核对官方校验和）
npm run setup:cad       # CadQuery 2.8 / OCCT 7.9（哈希锁定）
npm run setup:physics   # Gmsh、CalculiX、Optuna、scikit-learn、MuJoCo、OpenUSD；加 -- --with-botorch 装 BoTorch
npm run setup:logistics # OR-Tools（哈希锁定），场外物流规划制品
npm run start           # http://127.0.0.1:4317
```

端到端检查：

```bash
npm run check           # 单元测试 + 桌面契约
npm run test:fea        # t=3 mm 几何检查通过，挠度超限被否决
npm run test:optimize   # AI 种子 + 代理模型 + 正式复核（PAI_OPTIMIZE_STRATEGY=botorch-qlognehvi 切换策略）
npm run test:robot      # MuJoCo 碰撞 → 修正；CAD 装到机械臂；MJCF / OpenUSD
npm run test:aero       # 需要 PAI_OPENFOAM_IMAGE：35° 拒绝 → 12.5° 复测通过
npm run test:cad        # B-Rep 检查、DFM
npm run test:cam        # 需要 npm run setup:cam：G-code + 独立切削仿真
npm run test:package    # 签名发布包、篡改检测
npm run test:artifacts  # 制品库 → 流程 → 签名包 → 新环境复现；不可行、超时、篡改、结构错误
npm run test:suite      # 典型工业设计用例
npm run test:browser
```

配置见 [.env.example](.env.example)，本机配置写在 `.state/demo.env`。提示词、SQLite、证据包和凭据只保存在被 Git 忽略的 `.state`。服务默认只绑定 loopback；托管部署和登录见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 原则与边界

- **结论只来自原生求解器**：模型输出只能成为计划、种子或建议（`authority: none`）；代理模型只排序。
- **不确定就不重放**：结果未知的原生或模型运行等人工核对，不自动重试。
- **仿真不等于物理验证**：所有记录带 `physicalValidation: false`；唯一的实测记录是首件检验（`physicalMeasurement: true`）。
- **范围外**：认证级 FEA、疲劳、公差叠加、现场安全认证、自动发布、真实硬件控制（Strands Robots 只用仿真）、计费。

## 文档

- 使用：[API 与闭环操作](docs/API.md) · [典型测试用例](docs/INDUSTRIAL_TEST_CASES.md) · [AWS 部署与登录](docs/DEPLOYMENT.md)
- 通道：[结构与机器人](docs/PHYSICS.md) · [CAM](docs/CAM.md) · [气动](docs/AERO.md) · [产线](docs/PLANT.md) · [生成代码](docs/CAD_CODE.md)
- 设计：[整体架构（权威）](docs/SYSTEM_DESIGN.md) · [ADR 0001 制品与流程](docs/adr/0001-artifacts-and-workflows.md) · [ADR 0002 引擎平台与本体](docs/adr/0002-physical-ai-engine-platform.md) · [ADR 0003 本体为核心、通道为插件](docs/adr/0003-ontology-kernel-plugins.md) · [需求](docs/REQUIREMENTS.md) · [规划](docs/ROADMAP.md) · [实际验证记录](docs/VERIFICATION.md) · [Agent 运行时](docs/AGENT_RUNTIME.md)
- 背景：[行业对标与开源复用](docs/INDUSTRY_BENCHMARK.md) · [界面对比](docs/UI_UX_BENCHMARK.md) · [各通道设计取舍](docs/ARCHITECTURE.md) · [多端策略](docs/MULTIPLATFORM.md) · [Robot Reel 接入](docs/ROBOT_REEL_INTEGRATION.md)

本仓库新代码使用 MIT；Robot Reel 派生测试数据保留 Apache-2.0 与原始 NOTICE。见 [第三方说明](THIRD_PARTY_NOTICE.md)。
