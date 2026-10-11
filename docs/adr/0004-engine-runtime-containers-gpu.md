# ADR 0004：引擎运行时、容器化与 GPU

状态：采纳（2026-10-11）。分步实施，每步一个 PR，验证后上线。

## 背景

托管实例改为 g6.xlarge（NVIDIA L4）后，原生工具仍以进程方式直接在宿主机运行：各通道里约 30 处直接调用解释器路径，AI 生成的代码靠 `bwrap` 隔离；只有 FEA、CFD、CAM 在 AWS Batch 上用容器。GPU 只有 Strands Decider 在用，Blender Cycles 与 Newton 写死 CPU。这带来三个问题：工具版本只能靠安装回执间接证明；本机、托管和 Batch 三种运行方式各写一套；要不要用 GPU、用了没有，回执里看不出来。

## 决定

1. **引擎运行时是执行原生引擎的唯一入口**（`src/kernel/engine-runtime.ts`）。一次调用写明工具链（`engine`）、进程后端用的程序、参数、超时、**声明的文件足迹**（只读输入、可写输出；发布内的 `native/` 隐式只读）、网络需求（`none`，或只提交/轮询 AWS 的 `aws`）、是否运行模型写的代码（`untrusted`）、GPU 偏好。后端只改变"在哪里跑"，不改变"算什么"：同一程序、同一参数、同一超时，无 shell，不自动重放。
2. **足迹默认强制检查**：参数里出现的绝对路径必须落在声明的挂载或 `native/` 内，否则在运行前拒绝（`ENGINE_FOOTPRINT`）。这样把一个通道搬进容器时不需要改调用点，也不会漏挂载。架构测试禁止通道绕过运行时直接起进程（openssl 封存、AI 执行器、git 溯源除外）。
3. **后端**：`process`（本机开发，与原行为一致）、`container`（托管主机）、`batch`（重计算，沿用现有 Batch）。
4. **一个引擎一个镜像**：本机容器与 Batch 用同一份 Dockerfile 与同一 ECR 镜像，按内容摘要打不可变标签，推送时扫描并签名，宿主机按摘要拉取并校验签名。镜像只含工具链；`native/` 脚本来自发布包并只读挂载，所以脚本改动不触发镜像重建，回执同时记录脚本摘要与镜像摘要。
5. **宿主机用 rootless Podman + Quadlet**，不装 Docker 守护进程，工作台不拿容器套接字。每次运行是一次性容器：`--network none`（`aws` 调用除外）、只读根文件系统、`--cap-drop ALL`、`no-new-privileges`、资源上限，只挂声明的足迹。GPU 通过 NVIDIA CDI 传入。Decider 改为 Quadlet 常驻容器。工作台本身仍是加固的 systemd 服务（它是裁决内核，需要管理宿主机上的容器）。
6. **模型写的代码**（`untrusted`）在容器后端用 gVisor（`runsc`）运行时，再加原有的资源限制；其他引擎用普通 OCI 运行时。
7. **GPU 只用在有收益且不改变裁决数值的地方**：Blender Cycles（OptiX，渲染图会变，射线实测的通道与围栏检查不变）、Newton 交叉校验（Warp CUDA，一致性容差内）、Decider。MuJoCo 裁决、CalculiX、Gmsh、OCCT、OR-Tools、FreeCAD CAM、OpenFOAM 没有成熟 GPU 路径，保持 CPU；MuJoCo Warp 只能作为新的交叉校验引擎另行验收。BoTorch 样本少于 100，保持 CPU 以保证复现。L4 显存由内核层 GPU 信号量分配（Decider 常驻约 4 GB），拿不到就退回 CPU；回执记录实际设备。

## 实施顺序

1. 引擎运行时 + `process` 后端，迁移全部调用点，足迹强制检查与架构测试。行为零变化。
2. 引擎镜像与 CI 构建（ECR、扫描、签名），Batch 改用同一批镜像。
3. 宿主机 Podman、NVIDIA CDI、gVisor；`container` 后端；Decider 容器化。
4. 通道逐个切到容器：logistics/yard → cad（含 gVisor）→ physics → robots/Newton（GPU）→ blender（GPU）。每次切换对比切换前后的原生回执（同输入下 CAD/FEA 检查数值、MuJoCo 节拍一致）。
5. GPU 信号量、回执中的镜像摘要与设备字段、部署文档。

## 进度

- 第 1 步（PR #44）：已合并。
- 第 2 步：`engines/Dockerfile.<引擎>` 六个镜像（cad、physics、blender、robots、newton、logistics），各自用宿主机同一个 `tools/setup_*.py` 装到同一布局 `/opt/pai/tools`，所以容器后端按前缀把宿主机工具路径映射进镜像。基础镜像按摘要固定，以 nobody 运行，`HOME=/tmp`；只复制安装脚本、版本 pin 和哈希锁，不含 `native/` 脚本。`tools/package_engines.py` 按每个 Dockerfile 及其复制的文件打 `engine-<引擎>-<16 位摘要>` 标签；独立 ECR 仓库 `pai-engines`（不可变标签、推送即扫描、每个引擎保留 3 个，不影响 Batch 在用的 `pai-solver` 镜像）；CodeBuild `pai-engine-images` 构建，新镜像先在无网络、只读根、无能力的容器里冒烟再推送；实例角色只获准从 `pai-engines` 拉取。本机加固容器（`--network none --read-only --cap-drop ALL`）冒烟：OR-Tools 9.15.6755、CadQuery 2.8.0（几何有效）、Strands Robots 0.5.3 + UR5e、gmsh 4.15.2 / CalculiX 2.21 / BoTorch 0.18.1、Newton 1.6.0 / Warp 1.17.0 `cuda True`、Blender 5.2.2 OptiX 看到 GPU。镜像签名留到第 3 步与宿主机校验一起做。

## 代价

镜像合计约 15–20 GB（ECR 存储与拉取）；宿主机切换时各有一次几分钟的停服；容器启动每次增加约 1 s。换来的是：工具链由镜像摘要直接证明，本机/托管/Batch 共用一套定义，隔离边界由运行时统一施加，GPU 使用可见、可复核。
