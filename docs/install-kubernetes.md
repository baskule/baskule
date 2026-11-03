# Install a Baskule cluster on Kubernetes

Kubernetes is the recommended way to run Baskule across machines. The Helm chart runs
celld as a StatefulSet and computers through the vendored OpenShell Kubernetes driver.
The [single-machine Compose install](install.md) remains available.

## Create a cluster and install

Use Linux amd64 worker nodes with a NetworkPolicy-enforcing CNI and a default,
block-backed StorageClass. Start with two nodes with 4 vCPU and 8 GiB each. A computer
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

For an evaluation with bundled RustFS:

```sh
helm install baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --create-namespace --set rustfs.enabled=true --timeout 10m
kubectl -n baskule port-forward svc/baskule 47090:80
```

The post-install hook creates the evaluation bucket and deploys the application.
Do not add `--wait` to the first install: celld cannot become ready before that hook.
Replace `X` with a published Baskule chart version. Open the private setup link printed
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
  mode: ingress
  ingress:
    className: nginx
    tls:
      - hosts: [baskule.example.com]
        secretName: baskule-tls
```

```sh
helm install baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --create-namespace --values values.yaml --timeout 10m
```

Install your Ingress controller, DNS record, and TLS certificate separately. The chart
sets ingress-nginx's streaming and one-hour timeout annotations. For another controller,
set equivalent annotations through `exposure.ingress.annotations`. Confirm WebSocket
upgrades, immediate SSE/NDJSON delivery, and upload-size limits on your controller.

To use an existing Gateway instead, set `exposure.mode: gateway` and
`exposure.gateway.name`, with optional `namespace` and `sectionName`. The chart creates
an HTTPRoute with one-hour request/backend timeouts. The Gateway listener must permit
routes from the Baskule namespace and support WebSockets and unbuffered responses.
Gateway API CRDs, the controller, certificates, and DNS remain operator-owned.

## GKE Standard

These commands follow Google's [zonal cluster guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/creating-a-zonal-cluster).
The source verification runner exercises this path on a disposable zonal cluster.

```sh
gcloud container clusters create baskule \
  --zone europe-west1-b --node-locations europe-west1-b \
  --num-nodes 2 --machine-type e2-custom-4-8192 \
  --image-type UBUNTU_CONTAINERD --enable-dataplane-v2
gcloud container clusters get-credentials baskule --zone europe-west1-b
```

Install Agent Sandbox, then run either Helm install command above. Dataplane V2 provides
NetworkPolicy enforcement. Use the cluster's block-backed default StorageClass.
For a private cluster, provide outbound image-registry and model-provider access.

For Google's managed Ingress, create a `BackendConfig` in the Baskule namespace:

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
healthy backends before opening the setup link. Google's
[Ingress configuration guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/ingress-configuration)
describes backend health checks, timeouts and optional reserved addresses.

Target Standard, with a native containerd runtime. Autopilot is not an accepted target
for this release because the required nested seccomp/Landlock behavior has not been
verified under its managed node restrictions. This is a verification limit, not a
claim that Autopilot requires privileged pods. Google's [Autopilot security documentation](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security)
describes its enforced RuntimeDefault profile and admission constraints.

Do not set `runtimeClassName: gvisor` by default. OpenShell installs a seccomp
user-notification filter and uses Landlock inside the workload. GKE Sandbox uses gVisor
and [does not support the Linux security modules that OpenShell needs](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods).
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
RuntimeDefault seccomp. The workload needs nested seccomp user notification and
Landlock. OpenShell fails startup when required isolation operations are unavailable.
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
| `s3.existingSecret` | generated from supplied keys | S3 credentials; use the same keys for bundled RustFS |
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
uninstall. If you supply `existingSecret`, Helm prints the setup URL template and the
Secret name instead of reading its token into the notes.

## Upgrade and scale

Back up first, then upgrade the chart with your saved values:

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --values values.yaml --wait --timeout 10m
```

The hook deploys the Worker and asks every configured celld node to reload it. celld
pods update one at a time and have 50 seconds to hand off cells. App deployment is not
an atomic rollback of bucket state: `helm rollback` alone cannot undo a deployed bundle.

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --values values.yaml --set replicas=3 --wait --timeout 10m
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

Build branch images using [the build guide](building.md), including `openshell/build.sh`.
Build the release celld target with the current platform bundle. Use a dedicated tag
such as `kubernetes` for all six Kubernetes images. Then run:

```sh
source scripts/env.sh
scripts/check feature:kubernetes
```

The local check creates a kind cluster with Calico, Agent Sandbox and RustFS, using
a 1-CPU/1-GiB computer so it can run on a two-CPU CI host. The cloud run uses the
production computer defaults. The journey runs
setup, fake chat, computer exec, stop/start persistence, pod replacement, network
isolation, celld takeover, and a token-preserving Helm upgrade. kind's default local
PVCs stay on one node. The cloud check additionally forces a computer onto another
node with the same block volume.

Only with the installation owner's authorization, authenticate gcloud and set
`BASKULE_GKE_PROJECT` to the authorized active project. Run
`e2e/kubernetes-ephemeral.sh run`. Every gcloud operation selects that project
explicitly; the script does not change the account or project configuration.
It creates two Spot `e2-custom-4-8192` nodes in `europe-west1-b`, an ephemeral Artifact
Registry repository, a disposable node service account, and a real GKE Ingress.
It checks cross-node PD reattachment and incremental chat over the public load balancer.

The script records node-hours under `.run/evidence/` and enforces a 90-minute lifetime
plus teardown time. Its EXIT/INT/TERM trap deletes the cluster, repository, node identity
and remaining owned disks or load-balancer resources. Resources carry
`baskule-ephemeral=true` and `baskule-run=<run-id>` where their APIs support labels.
Other GKE-managed resources carry the unique run name in their names or descriptions.
The cleanup audit also detects disks and load-balancer resources added since the run's
baseline. Run `e2e/kubernetes-ephemeral.sh sweep` after an interrupted host session,
then `audit`. Never publish kubeconfigs, private inventory, Helm notes or raw payloads.
To repeat only public Ingress and Helm-upgrade verification after the core journey
passes on the same chart and images, set `BASKULE_K8S_JOURNEY=ingress` for the run.

## Limits

This is alpha software. The chart does not migrate a Compose installation and changes
no data in an existing install. Gateway HA, controller installation, model-provider
credentials, TLS automation, and multi-zone storage failover are outside this chart.
Volumes can move only where the selected StorageClass permits. OpenShell persists
all of `/sandbox`, including `/sandbox/space`; existing workspace image contents are
not automatically refreshed when the computer image changes. EKS, AKS, Kapsule, alternative
Ingress/Gateway controllers, and full disaster recovery need their own verification.
