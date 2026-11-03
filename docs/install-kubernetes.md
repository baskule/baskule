# Install a Baskule cluster on Kubernetes

Kubernetes is the recommended way to run Baskule across machines. The Helm chart runs
celld as a StatefulSet and computers through the vendored OpenShell Kubernetes driver.
The [single-machine Compose install](install.md) remains available.

## Create a cluster and install

Install kubectl and Helm **3.14 or newer**; the upgrade commands require
`--reset-then-reuse-values`.

Use Linux amd64 worker nodes with a NetworkPolicy-enforcing CNI and a default,
block-backed StorageClass. Use RFC 1918 Pod and Service CIDRs; privately used public
ranges need operator egress denial (see GKE below). Start with two nodes with 4 vCPU and 8 GiB each. A computer
requests 2 CPU and 3 GiB by default, in addition to the platform and OpenShell pods.
For production, size the pool for concurrent computers and keep nodes in the zones
supported by your volumes. Read the isolation and storage limits below.

Use cluster-admin permissions for the first install, including the gateway's
TokenReview and node-reader RBAC. Install Kubernetes SIG Apps' [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
CRDs and controller once per cluster. The vendored OpenShell driver requires them.
Baskule does not manage this cluster-wide prerequisite.

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox.yaml
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
```

The chart is available **from the next release**; release 0.5.0 has no chart.
For an evaluation with bundled RustFS:

```sh
helm install baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --create-namespace --set rustfs.enabled=true --timeout 10m
kubectl -n baskule port-forward svc/baskule 47090:80
```

The post-install hook creates the evaluation bucket and deploys the application.
Do not add `--wait` to the first install: celld cannot become ready before that hook.
Replace `X` with the version listed on [Baskule Releases](https://github.com/baskule/baskule/releases) (without a leading `v`). Open the private setup link printed
by Helm and create the first admin. Configure your model provider in Administration.
RustFS has one replica and no redundancy. Use it for tests and evaluation only.

For production, use a private S3 endpoint or operator-managed egress rules that deny
supervisor access to public S3 endpoints. This is required for strict storage network
isolation; standard NetworkPolicy alone cannot enforce a DNS-based exclusion.
Create an external bucket and a Kubernetes Secret containing
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Supply credentials through your secret
manager or an untracked file. Keep credentials out of shell history and chart values.
Use an S3-compatible service with atomic `If-Match` and `If-None-Match` writes. celld
uses those operations for its leases. A plain object upload/download test is insufficient.
Google Cloud Storage's XML endpoint is not a substitute for a verified S3 service.

```yaml
# values.yaml
publicUrl: https://baskule.example.com
s3:
  endpoint: https://s3.storage.internal
  region: us-east-1
  bucket: baskule
  existingSecret: baskule-bucket
exposure:
  mode: gateway
  gateway:
    name: public # an existing Gateway with a configured HTTPS listener
```

```sh
helm install baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --create-namespace --values values.yaml --timeout 10m
```

Install your Gateway/Ingress controller, DNS record, and TLS certificate separately.
The GKE Ingress and Gateway recipes below are evaluation-only until Baskule has
verified per-client client-IP handling. Do not use these recipes for production.
[ingress-nginx retired in March 2026](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
and is not recommended for new installations. For existing installations, the chart's
nginx annotations allow 1 GiB bodies, disable request/response buffering, and set
one-hour read/send timeouts. Other controllers need equivalent settings. Confirm
WebSocket upgrades, immediate SSE/NDJSON delivery, and upload-size limits.

To use an existing Gateway instead, set `exposure.mode: gateway` and
`exposure.gateway.name`, with optional `namespace` and `sectionName`. The chart creates
an HTTPRoute with one-hour request/backend timeouts. The Gateway listener must permit
routes from the Baskule namespace and support WebSockets and unbuffered responses.
Gateway API CRDs, the controller, certificates, and DNS remain operator-owned.
The Gateway example is unverified on GKE, including its client-IP behavior.

## GKE Standard

These commands follow Google's [zonal cluster guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/creating-a-zonal-cluster).
This is the verified cloud path. The packaged chart was tested on GKE
`1.36.4-gke.2046003` with Ubuntu containerd, Dataplane V2 and two Spot nodes with
4 vCPU and 8 GiB each. Across focused runs with matching production images,
verification covered setup, fake chat, computer execution, stop/start and cross-node
PVC persistence, direct and supervisor-mediated denial, GKE metadata, CDP, celld
takeover, space/PVC deletion, public WebSocket and HTTP/SSE transport streaming past
65 seconds, and same-version Helm upgrade with stable platform and storage secrets.
A measured cold first computer start took 71.7 seconds against the 180-second
readiness timeout. TLS and snapshot restore remain unverified.

Prerequisites: a Google Cloud project with billing enabled, an authenticated Google
Cloud CLI, `gke-gcloud-auth-plugin`, kubectl, and Helm 3.14 or newer (`--reset-then-reuse-values` support).
Use your own project explicitly; these commands do not change gcloud configuration.
Enable the Kubernetes Engine API in that project:

```sh
export GKE_PROJECT=your-project-id
gcloud --project="$GKE_PROJECT" services enable container.googleapis.com
gcloud --project="$GKE_PROJECT" container clusters create baskule \
  --zone europe-west1-b --node-locations europe-west1-b \
  --num-nodes 2 --machine-type e2-custom-4-8192 \
  --image-type UBUNTU_CONTAINERD --enable-dataplane-v2 --enable-ip-alias \
  --cluster-ipv4-cidr 10.40.0.0/14 --services-ipv4-cidr 10.44.0.0/20
gcloud --project="$GKE_PROJECT" container clusters get-credentials baskule --zone europe-west1-b
```

The ephemeral verification command additionally used Spot VMs, a disposable node
service account with node and registry-reader roles, 40-GB `pd-standard` boot disks,
and disabled workload/system logging, monitoring and managed Prometheus. The command
above uses on-demand nodes, the project default node identity, and GKE's disk and
observability defaults. It needs an identity with the required node permissions.

Install Agent Sandbox, then run either Helm install command above. Dataplane V2 provides
NetworkPolicy enforcement. Use the cluster's block-backed default StorageClass.
Choose non-overlapping RFC 1918 Pod and Service ranges before creating the cluster.
Do not use GKE's Google-managed `34.118.224.0/20` Service range here: OpenShell's
public-internet policy treats globally routable addresses as public even when a
cluster privately uses them. The same warning applies to privately used public Pod
ranges on any provider. Supporting such ranges requires operator egress denial;
configurable cluster-CIDR exclusions in the supervisor remain an open item.
For a private cluster, provide outbound image-registry and model-provider access.

For an evaluation using Google's managed Ingress, create a `BackendConfig` in the Baskule namespace:

```yaml
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: baskule
spec:
  timeoutSec: 3600
  healthCheck:
    type: HTTP
    port: 47091
    requestPath: /.well-known/celld/health
```

Set these chart values and provide a DNS record for `publicUrl`:

```yaml
exposure:
  mode: ingress
  serviceAnnotations:
    cloud.google.com/neg: '{"ingress":true}'
    cloud.google.com/backend-config: '{"default":"baskule"}'
  ingress:
    annotations:
      kubernetes.io/ingress.class: gce
```

GKE reconciles its load balancer asynchronously. Wait for the Ingress address and
healthy backends before opening the setup link. Frontend route propagation can
continue after backends become healthy, returning transient Google Frontend HTML
404 or 502 responses. Verify the setup JSON and successful sign-in before starting
user journeys. Google's
[Ingress configuration guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/ingress-configuration)
describes backend health checks, timeouts and optional reserved addresses.

Client-IP limit: Google's load balancer [appends the client and forwarding-rule IPs
to X-Forwarded-For](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header).
Baskule currently takes the last entry, which is the load balancer IP. Better Auth
counts every request, including successful sign-ins: the entire installation shares
**10 `/sign-in/email` requests per 60 seconds** and **200 requests per minute across
auth routes** behind that forwarding rule. The 11th sign-in within a minute returns
429 for everyone. Forged earlier entries do not bypass this bucket. Additional edge
rate limits do not fix the shared application bucket. **GKE Ingress and Gateway are
evaluation-only until per-client client-IP handling is implemented and verified.**
Gateway client-IP behavior has not been tested on GKE.

Target Standard, with a native containerd runtime. Autopilot is not an accepted target
for this release because the required nested seccomp/Landlock behavior has not been
verified under its managed node restrictions. This is a verification limit, not a
claim that Autopilot requires privileged pods. Google's [Autopilot security documentation](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security)
describes its enforced RuntimeDefault profile and admission constraints.

Do not set `runtimeClassName: gvisor` by default. OpenShell installs a seccomp
user-notification filter and uses Landlock inside the workload. GKE Sandbox uses gVisor
and [does not support Linux security modules](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods),
so it does not provide the same Landlock isolation.
Other RuntimeClasses require a successful computer journey before use.

## Scaleway Kapsule

This provider path has not been run on a Kapsule cluster.

With your Scaleway CLI credentials configured privately:

```sh
scw k8s cluster create name=baskule cni=calico \
  pools.0.name=computers pools.0.node-type=DEV1-L pools.0.size=2 --wait
scw k8s kubeconfig install <cluster-id>
```

Install Agent Sandbox and then the chart, as above. Kapsule provides the
[Block Storage CSI driver and a default StorageClass](https://www.scaleway.com/en/docs/kubernetes/api-cli/managing-storage/).
Keep nodes eligible to attach the same zonal volumes. Use Calico or another enforcing
CNI. Native containerd is the intended runtime; no gVisor installation is required.

## Isolation and network rules

The gateway and each computer's workload/supervisor pods run without privileged mode,
host networking, host PID namespaces, or a Docker socket. Workload and supervisor pods
run as non-root, drop all capabilities, disable privilege escalation, and use
RuntimeDefault seccomp. The workload uses nested seccomp user notification and
Landlock. Baskule currently selects Landlock's `best_effort` compatibility: unsupported
kernels can start with degraded filesystem restrictions. A successful exec alone does
not prove Landlock enforcement. Check OpenShell's isolation diagnostics when choosing
another node image or runtime.
Keep the namespace exclusive to Baskule and its trusted operators.

The chart restricts port 47092 to celld pods and its deployment job. It restricts the
private, anonymous OpenShell user API to computerd and trusted gateway/supervisor pods.
Do not expose that Service or grant untrusted users access to port-forward it.

Computer workloads have no direct egress, including DNS, S3, peer ports, metadata IPs,
and private ranges. A trusted OpenShell supervisor mediates outbound requests and
applies Baskule's public-internet-only policy. Upstream's supervisor policy permits
its own egress; workload restrictions and the supervisor's application policy both
matter. NetworkPolicies are additive: do not add a broad egress allow to workload pods.
For external S3 on public IPs, standard NetworkPolicy cannot identify an endpoint by
DNS name or subtract the upstream driver's supervisor egress allow. The workload still
has no direct egress, and S3 credentials stay with celld. Strict denial of even
supervisor-mediated connections to a public S3 endpoint requires a private storage
endpoint or operator-owned CNI/firewall rules. Do not assume the in-cluster RustFS
network test proves that additional restriction for every external S3 provider.

Disabling `networkPolicy.enabled` removes the chart's private-service protection and
is unsuitable for a shared cluster.

Garage v2.5.0 was tested and rejected by celld's conditional-write safety probe.
Garage's [known issues](https://garagehq.deuxfleurs.fr/documentation/reference-manual/known-issues/)
confirm that its design does not support conditional writes. It is unsuitable for
celld leases. The evaluation option therefore uses RustFS, also used by Compose.

## Values

The [checked-in values](../deploy/helm/baskule/values.yaml) are the full reference.
The main settings are:

| Value | Default | Purpose |
| --- | --- | --- |
| `publicUrl` | `http://localhost:47090` | Public origin and setup link |
| `replicas` | `2` | celld nodes, stable pod names and peer DNS |
| `s3.endpoint`, `region`, `bucket` | external endpoint required | Shared celld storage |
| `s3.existingSecret` | empty | Operator-owned S3 Secret; required for GitOps |
| `s3.accessKeyId`, `secretAccessKey` | empty | External S3 keys, applied on each upgrade when no existing Secret; RustFS keys are generated once |
| `rustfs.enabled` | `false` | Single-node evaluation S3 store |
| `existingSecret` | generated once | `COMPUTERD_TOKEN`, `SETUP_TOKEN`, `PLUGIN_SYNC_TOKEN` |
| `exposure.mode` | `none` | `none`, `ingress`, or `gateway` |
| `exposure.serviceAnnotations` | `{}` | Worker Service annotations for the selected controller |
| `computer.cpu`, `memory` | `2`, `3Gi` | Per-computer resource limits |
| `openshell.server.workspaceDefaultStorageSize` | `10Gi` | New per-space PVC capacity |
| `openshell.server.workspaceStorageClass` | cluster default | New per-space PVC StorageClass |
| `openshell.server.dataStorageClass` | cluster default | Gateway database StorageClass |
| `global.image.registry`, `tag` | GHCR, chart version | Platform and OpenShell images |

Supply private registry credentials through both `imagePullSecrets` and
`openshell.imagePullSecrets`/`openshell.server.sandboxImagePullSecrets` as needed.
The generated platform and S3 Secrets use Helm lookup on upgrade and are retained on
uninstall. Only generated RustFS keys are preserved; supplied external S3 values
replace the managed S3 Secret's keys on upgrade. Moving buckets also requires copying
bucket data before switching values; changing credentials alone does not move data.
Pods read keys at startup. For a credentials-only change, run
`kubectl -n baskule rollout restart statefulset/baskule-celld` after updating the
Secret; restart RustFS too if its credentials changed.

GitOps (`helm template`, ArgoCD) and client-side dry runs cannot use server lookup:
they generate new random values on each render. **Set both `existingSecret` and
`s3.existingSecret` for those workflows**, including evaluation RustFS. Manage the
three platform tokens and two S3 keys outside Helm. Also set `openshell.server.credentialStorage.existingSecret` to a pre-created
Secret containing `key-encryption-key`, as documented by the vendored chart.
Helm CLI installation is verified; GitOps controller hook ordering is not.
If you supply `existingSecret`, Helm prints the setup URL template and the
Secret name instead of reading its token into the notes.

## Upgrade and scale

Back up first, then upgrade the chart with your saved values:

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --reset-then-reuse-values --values values.yaml --wait --timeout 10m
```

`--reset-then-reuse-values` merges your saved overrides onto the new chart defaults,
so a default image tag advances with the chart. An explicitly pinned
`global.image.tag` remains pinned; remove it or update it deliberately. Plain
`--reuse-values` retains the previous release's default tag and must not be used for
a version upgrade. Keep evaluation `rustfs.enabled=true` in saved values.

The hook deploys the Worker and asks every configured celld node to reload it. celld
pods update one at a time and have 50 seconds to hand off cells. App deployment is not
an atomic rollback of bucket state: `helm rollback` alone cannot undo a deployed bundle.

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --reset-then-reuse-values --values values.yaml --set replicas=3 --wait --timeout 10m
```

Use Helm for scaling so the reload target list tracks the replica count. Persist that
count in `values.yaml`. Computer scheduling follows Kubernetes capacity; the platform
continues to use one computerd Service. computerd and the SQLite-backed gateway each
have one replica. Restarting either can interrupt active streams.

## Back up and restore

Back up the whole celld bucket, the Helm values/version, and all Baskule/OpenShell
Secrets. Back up the gateway database PVC and every computer workspace PVC with your
CSI VolumeSnapshot provider. The gateway database contains the mapping from spaces
to Sandbox resources, so workspace snapshots alone are insufficient.

For a consistent recovery point, stop incoming traffic, stop computers through the
product, and scale celld, computerd, and the gateway to zero:

```sh
kubectl -n baskule scale statefulset/baskule-celld \
  statefulset/baskule-openshell deployment/baskule-computerd --replicas=0
```

Keep the Sandbox resources, which carry each computer's durable identity. Export
those resources and claim names privately. Take CSI VolumeSnapshots of the gateway
and workspace claims with your provider's VolumeSnapshotClass, then copy the entire
bucket into a separately protected backup. Keep the Secrets with that recovery point.
Restart the gateway and computerd at one replica and celld at the count in your values.
Do not take a live SQLite filesystem copy as a substitute for this procedure.

To recover disks in the same cluster, stop the workloads again and restore claims
from the matching snapshots under their original names. Preserve the original Sandbox
resources and their UIDs, restore the matching bucket and Secrets, and restart the
workloads. Verify chat history and computer file bytes before reopening traffic.
Snapshot creation/restoration is provider-specific and has not yet been exercised
by this chart's journey. A new-cluster recovery also needs OpenShell's durable identity
bindings to be restored; recreating Sandbox YAML gives it a different UID. Do not treat
these snapshots as a verified cross-cluster disaster-recovery procedure.

## Uninstall

```sh
helm uninstall baskule --namespace baskule
```

Helm keeps generated Secrets and StatefulSet PVCs. The external bucket is untouched.
Dynamically created Sandbox resources and workspace PVCs also remain unless you
explicitly delete them. Preserve backups first. To erase a disposable installation,
delete its Sandboxes, then its PVCs and retained Secrets. Deleting Sandbox resources
removes their owned workspace claims. Check the CSI provider's reclaim policy and
cloud inventory for retained disks before deleting the cluster. The cluster-wide
Agent Sandbox controller may serve other installations; do not remove it automatically.

## Verify a source change

First run the exact Ubuntu build-environment command in [the build guide](building.md)
with `deploy/build.sh --no-deploy`. This builds web, runtime and all `:local` images,
including `openshell/build.sh`, without starting an installation. Use the same
image build before `scripts/check release`. Then bake the current platform bundle into the release celld target and tag
all six Kubernetes images explicitly:

```sh
source scripts/env.sh
scripts/docker-build.sh celld --network host --target release -t baskule-celld:kubernetes -f deploy/celld/Dockerfile .
for image in computerd openshell-kubernetes computer openshell-supervisor openshell-sandbox; do
  docker tag "baskule-$image:local" "baskule-$image:kubernetes"
done
BASKULE_K8S_TAG=kubernetes scripts/check feature:kubernetes
```

The local check creates a kind cluster with Calico, Agent Sandbox and RustFS, using
a 1-CPU/1-GiB computer so it can run on a two-CPU CI host. The cloud run uses the
production computer defaults. The journey runs
setup, fake chat, computer exec, stop/start persistence, pod replacement, network
isolation, celld takeover, space/PVC deletion, and a credential-preserving Helm upgrade.
Public checks exercise product WebSocket chat and a separate HTTP/SSE transport
probe that reuses the fake LLM behind the same Ingress. kind's default local
PVCs stay on one node. The cloud check additionally forces a computer onto another
node with the same block volume. The upgrade step re-applies the same chart/images
and asserts generated token stability and hook success. A separate two-version
rendering fixture packages the real defaults/image helper at 1.0.0 and 2.0.0, then
verifies the documented merge selects tag 2.0.0 without launching those fictitious
images. This does not prove application behavior across releases, schema migration,
or snapshot restoration.

Only with the installation owner's authorization, authenticate gcloud and set
`BASKULE_GKE_PROJECT` to the authorized active project. Run
`e2e/kubernetes-ephemeral.sh run`. Every gcloud operation selects that project
explicitly; the script does not change the account or project configuration.
It creates two Spot `e2-custom-4-8192` nodes in `europe-west1-b`, an ephemeral Artifact
Registry repository, a disposable node service account, and a real GKE Ingress.
It pushes the packaged chart to that OCI repository and installs it by version.
It checks cross-node PD reattachment and incremental chat over the public load balancer.

The script records node-hours under `.run/evidence/` and enforces a 90-minute lifetime
plus teardown time. Its EXIT/INT/TERM trap deletes the cluster, repository, node identity
and remaining owned disks or load-balancer resources. Resources carry
`baskule-ephemeral=true` and `baskule-run=<run-id>` where their APIs support labels.
Other GKE-managed resources carry the unique run name in their names or descriptions.
The cleanup audit also detects disks and load-balancer resources added since the run's
baseline. Run `e2e/kubernetes-ephemeral.sh sweep` after an interrupted host session,
or a lifetime/cleanup timeout, then `audit`. Kubernetes cleanup is bounded to eight
minutes, each API request is bounded, and cluster deletion is attempted even if that
phase times out. Teardown ignores repeated interrupts and gets up to 30 additional
minutes before a hard kill. A Git-common-directory lock is shared across worktrees of this repository: global
sweep refuses while a worker holds that project lock. It also refuses if any labelled
cluster or Artifact Registry repository is younger than 120 minutes, or its creation
time is unknown. This age guard covers other checkouts/machines; it is not a live
process detector. `sweep --force` bypasses both guards only for deliberate recovery.
Never publish kubeconfigs, private inventory, Helm notes or raw payloads.
To repeat only public Ingress and Helm-upgrade verification after the core journey
passes on the same chart and images, set `BASKULE_K8S_JOURNEY=ingress` for the run.
Use `BASKULE_K8S_JOURNEY=failover` after reschedule/isolation checks pass on the
same images. It prepares chat and file data, repeats configured public exposure,
celld takeover, space/PVC deletion and the Helm upgrade, and skips the earlier
reschedule/isolation/CDP selection. Set `BASKULE_K8S_JOURNEY=upgrade` to repeat
only install, server-side credential rendering and same-version upgrade checks.
The GKE runner requires the SDK's `docker-credential-gcloud` helper and uses a private
shared Docker/Helm helper configuration so long runs can renew registry credentials.

## Limits

The celld Worker port 47091 currently accepts ingress from all sources allowed by
the cluster network. Only the peer port has source restrictions. Restricting Worker
ingress to trusted controller/load-balancer sources and computerd remains open:
source identities and health-check ranges vary between controllers, and GKE can
rewrite source addresses. Operators must add controller-specific NetworkPolicy or
firewall rules after verifying the observed sources. This chart does not claim
Worker source isolation.

This is alpha software. The chart does not migrate a Compose installation and changes
no data in an existing install. Gateway HA, controller installation, model-provider
credentials, TLS automation, and multi-zone storage failover are outside this chart.
Volumes can move only where the selected StorageClass permits. OpenShell persists
all of `/sandbox`, including `/sandbox/space`; existing workspace image contents are
not automatically refreshed when the computer image changes. EKS, AKS, Kapsule, alternative
Ingress/Gateway controllers, and full disaster recovery need their own verification.
