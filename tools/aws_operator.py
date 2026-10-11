"""Scoped AWS operations; secret contents are written only to a mode-0600 local file."""
import argparse
import json
import os
import shlex
from pathlib import Path
import boto3

REGION = "ap-northeast-1"
ACCOUNT = "820674626047"


def session(role):
    c = boto3.client("sts").assume_role(
        RoleArn=f"arn:aws:iam::{ACCOUNT}:role/{role}", RoleSessionName="pai-workbench-operator"
    )["Credentials"]
    return boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                         aws_session_token=c["SessionToken"], region_name=REGION)


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["status", "login-file", "send", "apply-release", "result", "put-ai-keys"])
parser.add_argument("--script", type=Path)
parser.add_argument("--command-id")
args = parser.parse_args()
lookup = session(f"cdk-hnb659fds-lookup-role-{ACCOUNT}-{REGION}")
stack = lookup.client("cloudformation").describe_stacks(StackName="PAIDesignWorkbench")["Stacks"][0]
outputs = {p["OutputKey"]: p["OutputValue"] for p in stack["Outputs"]}
operator = session(f"cdk-hnb659fds-pai-operator-role-{ACCOUNT}-{REGION}")
if args.action == "status":
    result = operator.client("ssm").describe_instance_information(
        Filters=[{"Key": "InstanceIds", "Values": [outputs["InstanceId"]]}]
    )["InstanceInformationList"]
    print(json.dumps({"stack": stack["StackStatus"], "outputs": outputs, "ssm": result}, default=str, indent=2))
elif args.action == "login-file":
    value = operator.client("secretsmanager").get_secret_value(SecretId=outputs["AdminSecretArn"])["SecretString"]
    target = Path(__file__).resolve().parents[1] / ".state/deploy/admin-login.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(value + "\n")
    target.chmod(0o600)
    print(f"Private administrator login saved to {target}; not printed or committed.")
elif args.action in ("send", "apply-release"):
    if args.action == "send" and not args.script:
        parser.error("--script is required")
    if args.action == "apply-release":
        source = Path(__file__).resolve().parents[1] / "infra/update_release.sh"
        variables = {"PAI_RELEASE_HASH": outputs["ReleaseHash"], "PAI_ASSET_BUCKET": outputs["ReleaseBucket"],
                     "PAI_ASSET_KEY": outputs["ReleaseKey"], "PAI_EXECUTOR_KEY": outputs.get("ExecutorKey", ""),
                     "PAI_AI_KEYS_ARN": outputs.get("AiKeysArn", ""),
                     "PAI_AGENT_USER_POOL_ID": outputs.get("AgentUserPoolId", ""), "PAI_AGENT_CLIENT_ID": outputs.get("AgentClientId", ""), "PAI_TENANTS": outputs.get("Tenants", ""),
                     "PAI_SIGNING_KMS_KEY_ID": outputs.get("SigningKeyId", ""),
                     # Archiving writes COMPLIANCE-locked objects that nobody can delete early: opt in explicitly.
                     "PAI_PACKAGE_ARCHIVE_BUCKET": outputs.get("PackageArchiveBucket", "") if os.environ.get("PAI_ENABLE_PACKAGE_ARCHIVE") == "1" else "",
                     "PAI_PACKAGE_RETENTION_DAYS": outputs.get("PackageRetentionDays", ""),
                     "PAI_TSA_URL": os.environ.get("PAI_TSA_URL", "http://timestamp.digicert.com")}
        for opt_in in ("PAI_PHYSICS_BOTORCH", "PAI_PHYSICS_NEWTON", "PAI_ROBOTS", "PAI_DECIDER"):
            if os.environ.get(opt_in) == "1":
                variables[opt_in] = "1"
        # Engine containers (ADR 0004): PAI_ENGINE_CONTAINERS=logistics,... ; images resolved to digests from the
        # PAISolver stack's tags, so the host pulls exactly what CodeBuild pushed and scanned.
        if os.environ.get("PAI_ENGINE_CONTAINERS"):
            look = session(f"cdk-hnb659fds-lookup-role-{ACCOUNT}-{REGION}").client("cloudformation")
            solver = {o["OutputKey"]: o["OutputValue"] for o in look.describe_stacks(StackName="PAISolver")["Stacks"][0]["Outputs"]}
            tags, uri = json.loads(solver["EngineImageTags"]), solver["EngineRepositoryUri"]
            wanted = [e.strip() for e in os.environ["PAI_ENGINE_CONTAINERS"].split(",") if e.strip()]
            ecr = operator.client("ecr")
            images = {}
            for e in wanted:
                d = ecr.describe_images(repositoryName=uri.split("/", 1)[1], imageIds=[{"imageTag": tags[e]}])["imageDetails"][0]
                images[e] = f"{uri}@{d['imageDigest']}"
            variables.update({"PAI_ENGINE_CONTAINERS": ",".join(wanted), "PAI_ENGINE_IMAGES": json.dumps(images, separators=(",", ":"))})
        # FEA scale-out on AWS Batch (PAISolver stack; fixed names, see infra/solver.ts). Opt in per deployment.
        if os.environ.get("PAI_ENABLE_SOLVER_BATCH") == "1":
            account = boto3.client("sts").get_caller_identity()["Account"]
            variables.update({"PAI_SOLVER_QUEUE": "pai-solver", "PAI_SOLVER_JOB_DEFINITION": "pai-solver-fea",
                              "PAI_SOLVER_BUCKET": f"pai-solver-jobs-{account}-ap-northeast-1", "PAI_SOLVER_REGION": "ap-northeast-1",
                              "PAI_SOLVER_CFD_JOB_DEFINITION": "pai-solver-cfd", "PAI_SOLVER_CAM_JOB_DEFINITION": "pai-solver-cam"})
        script = "#!/bin/bash\n" + "\n".join(f"export {key}={shlex.quote(value)}" for key, value in variables.items()) + "\n" + source.read_text()
    else:
        # PAI_SEND_* variables are passed to the script (PAI_SEND_E2E=fea-e2e -> E2E=fea-e2e), quoted.
        passed = {k[len("PAI_SEND_"):]: v for k, v in os.environ.items() if k.startswith("PAI_SEND_")}
        script = "#!/bin/sh\n" + "".join(f"export {k}={shlex.quote(v)}\n" for k, v in passed.items() if k.isidentifier()) + args.script.read_text()
    response = operator.client("ssm").send_command(
        InstanceIds=[outputs["InstanceId"]], DocumentName="AWS-RunShellScript",
        Parameters={"commands": [script], "executionTimeout": ["1800"]},
        Comment="PAI workbench authorized deployment verification",
    )
    print(response["Command"]["CommandId"])
elif args.action == "put-ai-keys":
    # Reads the local Kiro key files exactly as the executor does and stores them; values are never printed.
    import re
    home = Path.home()
    primary = re.findall(r"^(?:export\s+)?KIRO_API_KEY\s*=\s*(.+)$", (home / ".config/agent-cli/env").read_text(), re.M)
    if len(primary) != 1:
        raise SystemExit("expected exactly one primary KIRO_API_KEY")
    keys = {"primary": shlex.split(primary[0], comments=True)[0],
            "backup": (home / ".config/kiro-failover/backup.key").read_text().strip(),
            "backup2": (home / ".config/kiro-failover/backup2.key").read_text().strip()}
    if not all(re.fullmatch(r"ksk_[A-Za-z0-9_-]{20,}", v) for v in keys.values()) or len(set(keys.values())) != 3:
        raise SystemExit("unexpected key format or duplicate keys")
    operator.client("secretsmanager").put_secret_value(SecretId=outputs["AiKeysArn"], SecretString=json.dumps(keys))
    print(json.dumps({"stored": sorted(keys), "secret": outputs["AiKeysArn"].split(":")[-1]}))
elif args.action == "result":
    if not args.command_id:
        parser.error("--command-id is required")
    response = operator.client("ssm").get_command_invocation(
        CommandId=args.command_id, InstanceId=outputs["InstanceId"]
    )
    print(json.dumps({key: response.get(key) for key in
                     ["Status", "ResponseCode", "StandardOutputContent", "StandardErrorContent"]}, indent=2))
