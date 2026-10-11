import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { bedrockEngineStatements } from "./bedrock.js";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as backup from "aws-cdk-lib/aws-backup";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { SOLVER } from "./solver.js";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export class WorkbenchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const context = (key: string): string => {
      const value = this.node.tryGetContext(key);
      if (value === undefined) throw new Error(`Missing deployment context: ${key}`);
      return String(value);
    };
    const domain = context("domain"), zone = context("availabilityZone");
    const vpc = ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
      vpcId: context("vpcId"), availabilityZones: [zone],
      publicSubnetIds: [context("subnetId")], publicSubnetRouteTableIds: [context("routeTableId")],
    });
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "AlbSecurityGroup", context("albSecurityGroupId"), { mutable: false });
    const group = new ec2.SecurityGroup(this, "InstanceSecurityGroup", {
      vpc, description: "PAI HTTP from the existing ALB only; no SSH ingress", allowAllOutbound: true,
    });
    group.addIngressRule(albSecurityGroup, ec2.Port.tcp(4317), "Existing authenticated ALB");
    const secret = new secrets.Secret(this, "AdminLogin", {
      secretName: "pai-workbench/admin",
      description: "Private PAI workbench Cognito administrator",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "qiangguo", url: `https://${domain}` }),
        generateStringKey: "password", passwordLength: 32, excludeCharacters: "\"'\\`$&",
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: "pai-design-workbench", selfSignUpEnabled: false,
      signInAliases: { username: true }, accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { otp: true, sms: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const client = pool.addClient("AlbClient", {
      generateSecret: true,
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`https://${domain}/oauth2/idpresponse`], logoutUrls: [`https://${domain}/`] },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
    // Machine agents (e.g. AgentForge sessions through pai-mcp): OAuth 2.0 client credentials on a resource
    // server with read / propose / run scopes. `run` executes a validated plan step only inside a maintainer-issued autonomy
    // grant (granted tools, quota, expiry; no relaxations); there is no scope for approving, releasing or moving feedback.
    const agentApi = pool.addResourceServer("AgentApi", { identifier: "pai-agent", userPoolResourceServerName: "PAI agent API",
      scopes: [new cognito.ResourceServerScope({ scopeName: "read", scopeDescription: "Read the grounded workspace" }),
        new cognito.ResourceServerScope({ scopeName: "propose", scopeDescription: "Propose typed plans for human confirmation" }),
        new cognito.ResourceServerScope({ scopeName: "run", scopeDescription: "Run a validated plan step within a maintainer's autonomy grant" }),
        new cognito.ResourceServerScope({ scopeName: "tenant", scopeDescription: "Invite-only tenant: run offered workflows, read own runs and usage" })] });
    const agentClient = pool.addClient("AgentClient", {
      generateSecret: true, authFlows: {}, accessTokenValidity: cdk.Duration.hours(1), enableTokenRevocation: true,
      oAuth: { flows: { clientCredentials: true }, scopes: ["read", "propose", "run"].map(s =>
        cognito.OAuthScope.custom(`pai-agent/${s}`)) },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });
    agentClient.node.addDependency(agentApi);
    // Invite-only tenants (ADR 0002 §5): one client each, only the tenant scope. Context `tenants`: JSON array of
    // { id, maxConcurrentRuns?, maxRunsPerDay? }; none by default. Secrets are readable by the operator only.
    const raw = this.node.tryGetContext("tenants") ?? "[]";
    const tenantSpecs = (typeof raw === "string" ? JSON.parse(raw) : raw) as { id: string; maxConcurrentRuns?: number; maxRunsPerDay?: number }[];
    const intIn = (v: unknown, lo: number, hi: number) => v === undefined || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi);
    if (!Array.isArray(tenantSpecs) || tenantSpecs.some(t => !/^[a-z][a-z0-9]{1,39}$/.test(t.id) || t.id === "workspace"
        || !intIn(t.maxConcurrentRuns, 1, 20) || !intIn(t.maxRunsPerDay, 1, 1000)) || new Set(tenantSpecs.map(t => t.id)).size !== tenantSpecs.length) {
      throw new Error("context tenants: unique lower-case alphanumeric ids (not workspace), maxConcurrentRuns 1-20, maxRunsPerDay 1-1000");
    }
    // The ALB jwt-validation claim allows at most 10 values: the workspace agent client plus 9 tenants.
    if (tenantSpecs.length > 9) throw new Error("at most 9 tenants per deployment (ALB claim limit)");
    const tenantClients = tenantSpecs.map(t => {
      const c = pool.addClient(`Tenant-${t.id}`, {
        userPoolClientName: `pai-tenant-${t.id}`, generateSecret: true, authFlows: {}, accessTokenValidity: cdk.Duration.hours(1), enableTokenRevocation: true,
        oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.custom("pai-agent/tenant")] },
        supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      });
      c.node.addDependency(agentApi);
      const secret = new secrets.Secret(this, `TenantSecret-${t.id}`, { description: `OAuth client secret of PAI tenant ${t.id}; read by the operator only`, secretStringValue: c.userPoolClientSecret });
      return { spec: t, client: c, secret };
    });
    const agentSecret = new secrets.Secret(this, "AgentClientSecret", {
      description: "OAuth client secret for PAI machine agents (client credentials); read by the operator only",
      secretStringValue: agentClient.userPoolClientSecret,
    });
    const authDomain = pool.addDomain("LoginDomain", {
      cognitoDomain: { domainPrefix: `pai-design-${this.account}` },
    });
    const initializeAdmin = new lambda.Function(this, "InitializeAdmin", {
      runtime: lambda.Runtime.PYTHON_3_14, handler: "index.handler",
      code: lambda.Code.fromInline(readFileSync(resolve("admin.py"), "utf8")),
      timeout: cdk.Duration.seconds(60),
    });
    secret.grantRead(initializeAdmin);
    initializeAdmin.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword"], resources: [pool.userPoolArn],
    }));
    const provider = new cr.Provider(this, "AdminProvider", { onEventHandler: initializeAdmin });
    new cdk.CustomResource(this, "AdminInitialization", {
      serviceToken: provider.serviceToken,
      properties: { SecretArn: secret.secretArn, PoolId: pool.userPoolId },
    });
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    const releasePath = resolve("../.state/deploy/release.tgz");
    const asset = new assets.Asset(this, "Release", {
      path: releasePath,
      assetHash: createHash("sha256").update(readFileSync(releasePath)).digest("hex"),
      assetHashType: cdk.AssetHashType.CUSTOM,
    });
    // Initial boot is immutable for this environment. Application updates use SSM.
    // Avoid replacing/stopping the instance merely because a frontend asset changed.
    asset.bucket.grantRead(role, context("bootstrapAssetKey"));
    asset.bucket.grantRead(role, asset.s3ObjectKey);
    // AI runtime: the pinned NoteFlow executor archive (private source, never in Git) and Kiro API keys.
    const executorPath = resolve("../.state/deploy/executor.tar");
    const executor = new assets.Asset(this, "Executor", {
      path: executorPath, assetHash: createHash("sha256").update(readFileSync(executorPath)).digest("hex"), assetHashType: cdk.AssetHashType.CUSTOM,
    });
    executor.bucket.grantRead(role, executor.s3ObjectKey);
    const aiKeys = new secrets.Secret(this, "AiKeys", {
      secretName: "pai-workbench/kiro-keys",
      description: "Kiro headless API keys for the PAI bounded executor (primary, backup, backup2); written by the operator, read by the instance",
    });
    aiKeys.grantRead(role);
    // Release-package signing: asymmetric key, private half never leaves KMS; the instance may only sign with it.
    const signingKey = new kms.Key(this, "ReleaseSigningKey", {
      description: "Signs PAI release-package manifests (ECDSA P-256)", keySpec: kms.KeySpec.ECC_NIST_P256, keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "pai-workbench/release-signing", removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    signingKey.grant(role, "kms:Sign", "kms:GetPublicKey");
    // FEA scale-out (PAISolver stack): submit and observe solver jobs, and read/write their jobs/ prefix. Names are
    // fixed so neither stack references the other.
    role.addToPolicy(new iam.PolicyStatement({ actions: ["batch:SubmitJob", "batch:TagResource"], resources: [
      `arn:aws:batch:${this.region}:${this.account}:job-queue/${SOLVER.queue}`, // Submitting by name (latest revision) is authorised against the unversioned ARN.
      `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.jobDefinition}`, `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.jobDefinition}:*`,
      `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.cfdJobDefinition}`, `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.cfdJobDefinition}:*`,
      `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.camJobDefinition}`, `arn:aws:batch:${this.region}:${this.account}:job-definition/${SOLVER.camJobDefinition}:*`,
      `arn:aws:batch:${this.region}:${this.account}:job/*`] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["batch:DescribeJobs"], resources: ["*"] }));
    // The Claude and Codex engines on Amazon Bedrock with the instance role (infra/bedrock.ts, tools/bedrock-engines.json).
    for (const statement of bedrockEngineStatements(this.account)) role.addToPolicy(statement);  // DescribeJobs has no resource-level permissions
    role.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject", "s3:GetObject"], resources: [`arn:aws:s3:::${SOLVER.bucket(this.account, this.region)}/jobs/*`] }));
    // Write-once archive of sealed release packages. Object Lock (COMPLIANCE default retention) means no principal,
    // including this stack and the account root, can delete or shorten a retained version before its date.
    const retentionDays = Number(this.node.tryGetContext("packageRetentionDays") ?? 365);
    const packages = new s3.Bucket(this, "ReleasePackages", {
      objectLockEnabled: true, objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(retentionDays)),
      versioned: true, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, minimumTLSVersion: 1.2,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Put and read back only; no delete, no governance bypass, no lock-configuration change.
    role.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectRetention", "s3:GetObjectAttributes"],
      resources: [packages.arnForObjects("releases/*")] }));
    const data = new ec2.Volume(this, "Data", {
      // 40 GiB until 2026-10-11; 60 GiB for the Strands Decider runtime and model (~10 GiB) with install headroom. Grows online.
      availabilityZone: zone, size: cdk.Size.gibibytes(60), volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const ami = new cdk.CfnParameter(this, "UbuntuAmi", {
      type: "AWS::EC2::Image::Id", default: context("amiId"),
      description: "Verified current Ubuntu 24.04 amd64 AMI; reviewed replacement required for upgrades",
    });
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `export PAI_VOLUME_ID='${data.volumeId}'`,
      `export PAI_RELEASE_HASH='${context("bootstrapReleaseHash")}'`,
      `export PAI_ASSET_BUCKET='${asset.s3BucketName}'`,
      `export PAI_ASSET_KEY='${context("bootstrapAssetKey")}'`,
      `export PAI_ALB_ARN='${context("albArn")}'`,
      `export PAI_ISSUER='https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}'`,
      `export PAI_CLIENT_ID='${client.userPoolClientId}'`,
      `export PAI_LOGOUT_URL='https://${authDomain.domainName}.auth.${this.region}.amazoncognito.com/logout?client_id=${client.userPoolClientId}&logout_uri=${encodeURIComponent(`https://${domain}/`)}'`,
      readFileSync(resolve("bootstrap.sh"), "utf8").replace(/^#!.*\n/, ""),
    );
    const instance = new ec2.Instance(this, "Workbench", {
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, role, securityGroup: group,
      // t3.medium originally; g6.xlarge (L4) since 2026-10-11 so Strands Decider runs on the same host (ADR 0002).
      instanceType: new ec2.InstanceType(String(this.node.tryGetContext("instanceType") ?? "t3.medium")),
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: ami.valueAsString }),
      associatePublicIpAddress: true, requireImdsv2: true,
      blockDevices: [{ deviceName: "/dev/sda1", volume: ec2.BlockDeviceVolume.ebs(16, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userData,
    });
    const attachment = new ec2.CfnVolumeAttachment(this, "DataAttachment", {
      instanceId: instance.instanceId, volumeId: data.volumeId, device: "/dev/sdf",
    });
    attachment.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "ExistingHttps", {
      listenerArn: context("listenerArn"), securityGroup: albSecurityGroup,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "Targets", {
      vpc, port: 4317, protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(instance, 4317)],
      healthCheck: { path: "/healthz", healthyHttpCodes: "200", interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: cdk.Duration.seconds(60),
    });
    listener.addAction("PaiRoute", {
      priority: Number(context("rulePriority")), conditions: [elbv2.ListenerCondition.hostHeaders([domain])],
      action: new actions.AuthenticateCognitoAction({
        userPool: pool, userPoolClient: client, userPoolDomain: authDomain,
        sessionCookieName: "PAIAuthSession", sessionTimeout: cdk.Duration.hours(1), scope: "openid",
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });
    // Agent API: the ALB verifies the access token (jwt-validation, RS256, issuer, token_use, client_id) before
    // forwarding; the workbench verifies it again with the route's scope. Narrower than the browser rule and
    // evaluated first; existing listener rules are untouched.
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;
    new elbv2.CfnListenerRule(this, "PaiAgentRoute", {
      listenerArn: context("listenerArn"), priority: Number(context("agentRulePriority")),
      conditions: [{ field: "host-header", hostHeaderConfig: { values: [domain] } }, { field: "path-pattern", pathPatternConfig: { values: ["/api/agent/*"] } }],
      actions: [
        { type: "jwt-validation", order: 1, jwtValidationConfig: { jwksEndpoint: `${issuer}/.well-known/jwks.json`, issuer,
          additionalClaims: [{ format: "single-string", name: "token_use", values: ["access"] },
          // A single-string claim takes exactly one value. With only the workspace agent client the ALB pins it; once
          // tenants exist the ALB checks signature, this pool's issuer and token_use, and the workbench pins the exact
          // client id, scope and tenant on every request (src/agent-api.ts, src/server.ts; tests/agent-api.test.ts).
          ...(tenantClients.length === 0 ? [{ format: "single-string", name: "client_id", values: [agentClient.userPoolClientId] }] : [])] } },
        { type: "forward", order: 2, targetGroupArn: targetGroup.targetGroupArn },
      ],
    });
    const vault = new backup.BackupVault(this, "Backups", { removalPolicy: cdk.RemovalPolicy.RETAIN });
    const plan = new backup.BackupPlan(this, "BackupPlan");
    plan.addRule(new backup.BackupPlanRule({
      backupVault: vault, scheduleExpression: cdk.aws_events.Schedule.cron({ hour: "18", minute: "0" }),
      deleteAfter: cdk.Duration.days(14), startWindow: cdk.Duration.hours(1), completionWindow: cdk.Duration.hours(2),
    }));
    plan.addSelection("PersistentState", {
      resources: [backup.BackupResource.fromArn(`arn:aws:ec2:${this.region}:${this.account}:volume/${data.volumeId}`)],
    });
    new cloudwatch.Alarm(this, "InstanceFailure", {
      metric: new cloudwatch.Metric({ namespace: "AWS/EC2", metricName: "StatusCheckFailed", dimensionsMap: { InstanceId: instance.instanceId }, statistic: "Maximum", period: cdk.Duration.minutes(5) }),
      threshold: 1, evaluationPeriods: 2,
    });
    new cloudwatch.Alarm(this, "UnhealthyTarget", {
      metric: targetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(5), statistic: "Maximum" }),
      threshold: 1, evaluationPeriods: 2,
    });
    const operator = new iam.Role(this, "Operator", {
      roleName: `cdk-hnb659fds-pai-operator-role-${this.account}-${this.region}`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/physical-ai-dcv-tokyo`),
      description: "PAI deployment verification and private admin credential retrieval",
    });
    secret.grantRead(operator);
    agentSecret.grantRead(operator);
    for (const t of tenantClients) t.secret.grantRead(operator);
    operator.addToPolicy(new iam.PolicyStatement({ actions: ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"], resources: [aiKeys.secretArn] }));
    operator.addToPolicy(new iam.PolicyStatement({
      actions: ["ssm:SendCommand"], resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
      ],
    }));
    operator.addToPolicy(new iam.PolicyStatement({ actions: ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"], resources: ["*"] }));
    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${domain}` });
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "VpcId", { value: vpc.vpcId });
    new cdk.CfnOutput(this, "DataVolumeId", { value: data.volumeId });
    new cdk.CfnOutput(this, "TargetGroupArn", { value: targetGroup.targetGroupArn });
    new cdk.CfnOutput(this, "AdminSecretArn", { value: secret.secretArn });
    new cdk.CfnOutput(this, "OperatorRoleArn", { value: operator.roleArn });
    new cdk.CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new cdk.CfnOutput(this, "AgentUserPoolId", { value: pool.userPoolId });
    new cdk.CfnOutput(this, "SigningKeyId", { value: signingKey.keyId });
    new cdk.CfnOutput(this, "PackageArchiveBucket", { value: packages.bucketName });
    new cdk.CfnOutput(this, "PackageRetentionDays", { value: String(retentionDays) });
    new cdk.CfnOutput(this, "AgentClientId", { value: agentClient.userPoolClientId });
    // Runtime mapping for PAI_TENANTS (client ids are not secrets); the operator writes it to /etc/pai/runtime.env.
    new cdk.CfnOutput(this, "Tenants", { value: cdk.Stack.of(this).toJsonString(tenantClients.map(t => ({ id: t.spec.id, clientId: t.client.userPoolClientId,
      maxConcurrentRuns: t.spec.maxConcurrentRuns ?? 2, maxRunsPerDay: t.spec.maxRunsPerDay ?? 50 }))) });
    for (const t of tenantClients) new cdk.CfnOutput(this, `TenantSecretArn${t.spec.id}`, { value: t.secret.secretArn });
    new cdk.CfnOutput(this, "AgentClientSecretArn", { value: agentSecret.secretArn });
    new cdk.CfnOutput(this, "AgentTokenUrl", { value: `https://${authDomain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token` });
    new cdk.CfnOutput(this, "ReleaseHash", { value: createHash("sha256").update(readFileSync(releasePath)).digest("hex") });
    new cdk.CfnOutput(this, "ReleaseBucket", { value: asset.s3BucketName });
    new cdk.CfnOutput(this, "ReleaseKey", { value: asset.s3ObjectKey });
    new cdk.CfnOutput(this, "ExecutorKey", { value: executor.s3ObjectKey });
    new cdk.CfnOutput(this, "AiKeysArn", { value: aiKeys.secretArn });
  }
}
