import * as cdk from "aws-cdk-lib";
import { WorkbenchStack } from "./stack.js";
import { AgentCoreBaseStack, AgentCoreRuntimeStack } from "./agentcore.js";
import { SolverStack } from "./solver.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const app = new cdk.App();
new WorkbenchStack(app, "PAIDesignWorkbench", {
  env: { account: "820674626047", region: "ap-northeast-1" },
  description: "PAI design workbench in the existing WordPress VPC, authenticated shared HTTPS entry",
});
const env = { account: "820674626047", region: "ap-northeast-1" };
// AgentCore stacks synthesize only when their build context is packaged (python3 tools/package_agentcore.py),
// so workbench deploys stay independent of them.
if (existsSync(resolve("../.state/deploy/agentcore-context"))) {
  const base = new AgentCoreBaseStack(app, "PAIAgentCoreBase", { env, description: "PAI AgentCore: dedicated VPC, ledger volume, ECR and arm64 image build" });
  // Runtimes are created only once the images for this tag exist (cdk deploy -c agentcoreImageTag=<tag>).
  const imageTag = app.node.tryGetContext("agentcoreImageTag");
  if (imageTag) new AgentCoreRuntimeStack(app, "PAIAgentCoreRuntime", { env, base, imageTag, description: "PAI AgentCore runtimes: CAD sandbox and Kiro agent" });
}
// FEA scale-out on AWS Batch; synthesized only when its image context is staged (python3 tools/package_solver.py, which also stages the engine images).
if (existsSync(resolve("../.state/deploy/solver-context"))) new SolverStack(app, "PAISolver", { env, description: "PAI FEA solver jobs on AWS Batch (Fargate, amd64)" });
cdk.Tags.of(app).add("project", "pai-design-workbench");
