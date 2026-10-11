# 演示

五段成片都在 pai.oneai.host 或本机实时录制，没有剪切或调换顺序，只把画面静止的等待片段加速播放。每段的回执在 [evidence](evidence/)。链接路径相对仓库根目录写成 `docs/...`，此处已改为相对本文件。

[![机器人工作单元提速：MuJoCo 发现碰撞、AI 修正、CalculiX 否决几何最优、物理寻优、KMS 签名发布](media/physics-demo.gif)](media/physics-demo.mp4)

**演示 A · 机器人工作单元提速，AI 设计、物理求解器裁决**：[docs/media/physics-demo.mp4](media/physics-demo.mp4)（约 5.5 分钟，1280×800）。在 pai.oneai.host 上实时录制，也可以在 [GitHub Release](https://github.com/noteflowai/pai-engine/releases/tag/demo-physics-2026-10-03) 下载。

1. 目标是节拍 ≤ 5 s（参考单元 5.9 s）。初版把关节速度提到 75 %、围栏内收到 0.12 m。MuJoCo 跑了 10 个种子：节拍 4.6 s 达标，但每个种子肘部都撞到围栏，EvalArc 判定候选丢失了基准通过的检查，结论为拒绝。
2. 在失败的检查上点“问 AI”。Kiro 2.27.1（claude-opus-5.5）引用 scene-1，把围栏退回 0.30 m，速度保持不变，没有放宽任何要求。复测 4 项全部通过：节拍 4.6 s，比参考单元快 22 %，10/10 个种子成功。失败案例通过绑定的复测关闭。
3. 电机支架冻结结构要求（60 N 皮带载荷、挠度 ≤ 0.06 mm）。只看几何时最轻的 t = 3 mm 能通过 7 项几何检查，但 CalculiX 实测挠度为 0.095 mm，被否决。
4. AI 按第一性原理提出 3 个种子并附上挠度估算。实测 19 个点，其中 7 个可行；最轻的可行点由代理模型的 exploit 步骤找到：t 3.67、W 60.05、H 49.53，46.9 g，挠度 0.058 mm。正式复核 9/9 通过。AI 的 3 个种子都略超限，求解器给它们打分，挠度估算偏低 10–14 %。
5. 两条反馈都已关闭，准入 5/5，R1 发布。在界面里核验签名：AWS KMS ECDSA P-256，20 个原生文件的摘要一致。

回执见 [physics-demo.json](evidence/physics-demo.json)。

英文讲解版（约 50 s，用于英文演讲）：`python3 tools/english_cut.py docs/evidence/physics-demo.en-cut.json physics-demo.en.mp4`。只做裁切和加速（画面上标出倍速），英文字幕里的数字从回执读出，不手写。

[![AI + Blender 设计工厂产线：原生生成、射线实测、AI 修正、复测通过](media/factory-demo.gif)](media/factory-demo.mp4)

**演示 B · AI + Blender 设计工厂产线**：[docs/media/factory-demo.mp4](media/factory-demo.mp4)（约 5 分钟，1280×800），也可以在 [GitHub Release](https://github.com/noteflowai/pai-engine/releases/tag/demo-factory-2026-10-03) 下载。

1. 用一句话描述 6 工位 CNC 机加工产线（围栏加大到 4.2 m、AGV 通道 2.4 m、厂房 ≤ 650 m²），解析成类型化计划。
2. Blender 5.2 按 8 个阶段生成整座车间，实时推送到三维视口：柱网桁架、输送线、CNC 加工中心、六轴机器人、安全围栏、货架、AGV、桥式起重机和检测相机，共 181 个对象，带 Cycles 渲染和动画。
3. BVH 射线实测发现耦合问题：加大的围栏挤占了通道，净宽只有 2.08 m（要求 ≥ 2.4 m），结论为拒绝。
4. 在失败的检查上点“问 AI”，真实调用 Kiro 主账号（claude-opus-5.5）。它在不放宽任何要求的前提下把通道加宽到 2.8 m。确认后重新生成：净宽 2.48 m，厂房 641.6 m²，5 项检查全部通过。

回执见 [factory-demo.json](evidence/factory-demo.json)，通道说明见 [PLANT.md](PLANT.md)。

![Blender Cycles 渲染：AI 修正后的 6 工位 CNC 产线](media/factory-render.png)

[![从设计到车间：6202 轴承座 H7 孔被拒绝、DFM/DFA、FreeCAD CAM 出 G-code、独立切削仿真、签名交付](media/cam-demo.gif)](media/cam-demo.mp4)

**演示 D · 从设计到车间**：[docs/media/cam-demo.mp4](media/cam-demo.mp4)（约 3.7 分钟，1440×900），也可以在 [GitHub Release](https://github.com/noteflowai/pai-engine/releases/tag/demo-cam-2026-10-05) 下载。全程只用原生工具，不调用模型。

1. 6202 轴承座冻结需求：Ø35 H7 轴承孔（35.000–35.025）、孔四周壁厚 ≥ 5 mm、M8 地脚孔边距 ≥ 1.5 d、外形 ≤ 120 × 40 × 60 mm。
2. 候选把轴承孔加工成 Ø34.95。CadQuery 逐个特征建模，OCCT B-Rep 实测孔径低于 H7 下限，其余检查都通过；EvalArc 判定丢失 1 项检查，结论为拒绝。
3. 回到基准设计并冻结制造要求。DFM 实测 2 次装夹、0 个孔受阻（M8 螺钉头和扳手有空间）、单件成本估算 28.53 EUR。FreeCAD 1.1 CAM 按装夹各出一份 G-code，另一个独立进程只读 G-code，在 0.1 mm 高度图上仿真：无过切、无残料、无过载、无快移碰撞，节拍 78.9 min，并给出仿真图。
4. 失败案例经反馈、复测、关闭后发布 R1。签名发布包含 STEP、两份 G-code、仿真报告和仿真图，车间拿到的程序与评审过的是同一份字节。

录制时发现并修正了 3 个问题（轴承座检查不能登记反馈、复测误用支架基准、构建中标题写成支架），回执见 [cam-demo.json](evidence/cam-demo.json)。

[![AI 设计轴承座，求解器裁决：维护者授权、真实模型提议、原生检查否决、物理寻优、正式复核、签名发布](media/ai-demo.gif)](media/ai-demo.mp4)

**演示 E · AI 设计轴承座，求解器裁决**：[docs/media/ai-demo.mp4](media/ai-demo.mp4)（约 4 分钟，1440×900），也可以在 [GitHub Release](https://github.com/noteflowai/pai-engine/releases/tag/demo-ai-2026-10-06) 下载。

1. 紧凑化轴承座（底座 88 mm、孔距 76 mm）的地脚孔边距只有 6 mm（要求 ≥ 13.5 mm），被 B-Rep 实测拒绝。
2. 维护者在总览签发授权（只允许 CAD 评审、最多 3 次）并给出目标。真实模型 Claude 经受控执行器和共享账本被调用一次。执行器无法自动确认模型调用没有副作用，停下等人核对；维护者记录理由后，在同一授权内执行。
3. AI 修好了孔边距（14 mm），但把轴承座厚度从 20 mm 加到 30 mm，并估计质量不超过 170 g。CadQuery 实测 208.9 g，超过 175 g 的上限，被否决：结论来自求解器，不来自模型。
4. 冻结 1 kN 上拔轴承载荷后做物理寻优：15 次 CalculiX 求解、10 个可行点，最轻 145.3 g，受载失圆 5.94 µm（上限 6 µm）；两级网格正式复核通过。
5. AI 战绩记录了这次被否决的提案；最初的失败经反馈、复测、关闭后发布 R1 并签名。

同一晚的前一次录制里，Claude 的提案被接受（137.957 g）；只因字幕把引擎写成了 "default" 才重录。两次结果都是真实的，回执与说明见 [ai-demo.json](evidence/ai-demo.json)。

英文讲解版（约 110 s，用于英文演讲）：`python3 tools/english_cut.py docs/evidence/ai-demo.en-cut.json ai-demo.en.mp4`。只做裁切和加速（画面上标出倍速），英文字幕里的数字从回执读出，不手写。

**演示 C · 生成式 CAD**：

[![生成式工业设计演示：AI 写 CadQuery 代码，原生 B-Rep 检查给出结论](media/demo.gif)](media/demo.mp4)

完整视频：[docs/media/demo.mp4](media/demo.mp4)（约 3 分钟，1280×800），也可以在 [GitHub Release](https://github.com/noteflowai/pai-engine/releases/tag/demo-2026-10-02) 下载。

视频里的全部结果都是录制时实时产生的：
1. NEMA 17 支架轻量化，板厚 4 → 2.5 mm，被原生检查拒绝。
2. 在“最小壁厚”这一行点“问 AI”，真实调用 Kiro 主账号（claude-opus-5.5），由它写出 CadQuery 代码。
3. 代码在三层沙箱中建模，通过全部 7 项检查，39.6 g。
4. 16 点原生设计空间扫描，找到最轻的可行设计 t = 3 mm，37.4 g，作为正式候选也通过了检查。

五段成片都没有剪切或调换顺序，只把画面静止的等待片段加速播放。CAD 演示的回执见 [demo.json](evidence/demo.json)。

**演示 F · 场外物流孪生**：[media/yard-twin.mp4](media/yard-twin.mp4)（约 30 秒，1440×640）。同一个合成工作日、同样的扰动（3 辆晚到、D4 停用 30 分钟），先到先服务与 PAI Engine（CP-SAT，传感器触发重排）并排运行；每一帧都来自 `native/yard_twin.py` 这次运行的方案，两份最终方案都经独立核验器通过。回执：[evidence/yard-twin.json](evidence/yard-twin.json)。复现：`npm run demo:yard-twin`。

[![F](media/yard-twin.gif)](media/yard-twin.mp4)

