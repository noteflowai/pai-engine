"""Operate the PAI solver (AWS Batch) through the scoped operator role; never prints credentials.

  python3 tools/solver_operator.py build          # build the immutable solver images for the deployed source asset and wait
  python3 tools/solver_operator.py build-engines  # build the engine images (ADR 0004) and print tag, size and digest
  python3 tools/solver_operator.py logs --job-id ID
"""
import argparse, json, sys, time
import boto3

REGION = "ap-northeast-1"
ACCOUNT = boto3.client("sts").get_caller_identity()["Account"]


def session(role):
    c = boto3.client("sts").assume_role(RoleArn=f"arn:aws:iam::{ACCOUNT}:role/{role}", RoleSessionName="pai-solver-operator")["Credentials"]
    return boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"], region_name=REGION)


def outputs():
    cf = session(f"cdk-hnb659fds-lookup-role-{ACCOUNT}-{REGION}").client("cloudformation")
    return {o["OutputKey"]: o["OutputValue"] for o in cf.describe_stacks(StackName="PAISolver")["Stacks"][0].get("Outputs", [])}


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["build", "build-engines", "logs"])
parser.add_argument("--job-id")
args = parser.parse_args()
op, out = session(f"cdk-hnb659fds-pai-operator-role-{ACCOUNT}-{REGION}"), outputs()
if args.action in ("build", "build-engines"):
    cb = op.client("codebuild")
    build = cb.start_build(projectName=out["SolverBuildProject"] if args.action == "build" else out["EngineBuildProject"])["build"]
    while True:
        b = cb.batch_get_builds(ids=[build["id"]])["builds"][0]
        if b["buildStatus"] != "IN_PROGRESS":
            break
        time.sleep(20)
    events = op.client("logs").get_log_events(logGroupName=b["logs"]["groupName"], logStreamName=b["logs"]["streamName"], limit=60, startFromHead=False)["events"]
    tail = [e["message"].rstrip() for e in events if any(k in e["message"] for k in ("exists", "fea-", "cfd-", "cam-", "engine-", "gmsh", "digest", "sha256"))][-8:]
    print(json.dumps({"status": b["buildStatus"], "imageTag": out["SolverImageTag"] if args.action == "build" else json.loads(out["EngineImageTags"]), "log": [t.replace(ACCOUNT, "<acct>") for t in tail]}, indent=1))
    sys.exit(0 if b["buildStatus"] == "SUCCEEDED" else 1)
else:
    lg = op.client("logs")
    for e in lg.filter_log_events(logGroupName=out["SolverJobLogGroup"], filterPattern="", limit=100)["events"][-40:]:
        print(e["message"].rstrip()[:300])
