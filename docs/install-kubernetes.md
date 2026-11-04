# Install a Baskule cluster on Kubernetes

Exec requires an API server supporting `v5.channel.k8s.io` (see [upstream WebSocket requirements](https://kubernetes.io/blog/2024/08/20/websockets-transition/)).

Kubernetes is the recommended way to run Baskule across machines. The Helm chart runs
celld as a StatefulSet and computerd as a Deployment. computerd runs each space's computer
as an Agent Sandbox `Sandbox` with a persistent volume.
Kubernetes is the only cluster install. The [single-machine Compose install](install.md) remains available.

The former multi-host Compose cluster is removed. Existing Compose-cluster operators must
create a Kubernetes installation using this guide; there is no migration or Compose-cluster
upgrade path. Before retiring the old installation, stop writes and back up its S3 bucket
(platform databases, accounts, sessions, credentials, chats and settings), computer host
state and disks, and deployment secrets. These backups do not have a supported restore
path into the chart. A fresh installation starts with new accounts, credentials, settings,
chats and computers. Deleting the old bucket and host volumes removes those platform
records, secrets and computer files. Only the installation owner may authorize stopping
the old installation or deleting that data.

## Create a cluster and install

Install kubectl and Helm **3.14 or newer**; the upgrade commands require
`--reset-then-reuse-values`.

Use Linux amd64 worker nodes with a NetworkPolicy-enforcing CNI and a default,
block-backed CSI StorageClass. Prefer RFC 1918 Pod and Service CIDRs; add any publicly
addressed cluster range to `computers.blockedCidrs` (see
[Isolation and network rules](#isolation-and-network-rules)). Start with two nodes with
4 vCPU and 8 GiB each. A computer requests 2 CPU and 3 GiB by default, in addition to the
celld and computerd pods. For production, size the pool for concurrent computers and keep
nodes in the zones supported by your volumes. Read the isolation and storage limits below.

Install Kubernetes SIG Apps' [Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
CRDs and controller once per cluster. This needs cluster-admin; Baskule does not manage
this cluster-wide prerequisite. The chart itself creates only namespaced resources,
including computerd's ServiceAccount, Role and RoleBinding. Creating that Role requires
holding every permission it grants, or the RBAC `escalate` permission.

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox.yaml
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
```

The chart is available **from the next release**; release 0.5.0 has no chart.
Every install needs an S3-compatible bucket with atomic `If-Match` and
`If-None-Match` writes. celld uses these operations for leases; an upload/download
test is insufficient. The chart contains no object store and fails rendering without
`s3.endpoint`, `s3.bucket`, and either `s3.existingSecret` or both key values.
Scaleway Object Storage (`fr-par`) passed celld's conditional-write check. AWS S3 and
Cloudflare R2 are unverified examples here. **Google Cloud Storage's S3 XML API is
unsupported:** it overwrote an existing object on a create-if-absent write in celld's
probe. See [storage conformance evidence](storage-conformance.md).
Garage v2.5.0 was tested and rejected by celld's conditional-write safety probe.
Garage's [known issues](https://garagehq.deuxfleurs.fr/documentation/reference-manual/known-issues/)
confirm that its design does not support conditional writes. It is unsuitable for
celld leases.

Create a bucket and a Kubernetes Secret containing `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, as in the Scaleway recipe below. Supply credentials through
your secret manager or an untracked private file. Keep credentials out of shell
history, chart values, and evidence.

Computers can reach public addresses and receive no S3 credentials. For strict storage
network isolation in production, use a private S3 endpoint or add the endpoint's address
ranges to `computers.blockedCidrs`. NetworkPolicy cannot match a DNS name.

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

The bucket must already exist. The post-install hook deploys the application.
Do not add `--wait` to the first install: celld cannot become ready before that hook.
Replace `X` with the version listed on [Baskule Releases](https://github.com/baskule/baskule/releases)
(without a leading `v`). Open the private setup link printed by Helm and create the
first admin. Configure your model provider in Administration.
For a local port-forward, omit `exposure` and use `publicUrl: http://localhost:47090`,
then run `kubectl -n baskule port-forward svc/baskule 47090:80`.
Keep the release name and namespace stable: computer and disk names derive from the
release name, and computerd finds them in its namespace.
After installing, check the bucket from a celld pod; `bucket conditional write` must report `ok`:

```sh
kubectl -n baskule exec baskule-celld-0 -- sh -ec 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"'
```

Install your Gateway/Ingress controller, DNS record, and TLS certificate separately.
`ingress` and `gateway` exposure require a non-loopback `publicUrl`; its host becomes the
route host. The GKE Ingress and Gateway recipes below are evaluation-only until Baskule has
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

## Computers

computerd uses a dedicated ServiceAccount, `<release>-computerd`, bound to a
least-privilege Role in the release namespace. The Role manages `agents.x-k8s.io`
Sandboxes (get, list, watch, create, patch, delete), reads pods, creates `pods/exec` and
`pods/portforward`, and reads and deletes PersistentVolumeClaims. computerd is the only
chart pod that mounts a service account token. That Role can exec into any pod in the
namespace: keep the namespace exclusive to Baskule and its trusted operators.

Each space has one `Sandbox` (`agents.x-k8s.io/v1beta1`). Its volumeClaimTemplate creates
a ReadWriteOnce PVC named `<disk>-<sandbox>` with `computers.diskSize` and
`computers.storageClass`, mounted at `/sandbox/space`. Only `/sandbox/space` persists; the
rest of the filesystem comes from the computer image and resets whenever the pod is
recreated, including on stop/start. computerd stops and resumes a computer by setting the
Sandbox's `operatingMode` to `Suspended` or `Running`. Exec and port connections, including
CDP, use the Kubernetes API WebSocket. Image, resource, disk and scheduling settings apply
when a Sandbox is created; existing computers keep theirs.

Computer pods run as non-root user and group 1000, drop all capabilities, disable privilege
escalation, use RuntimeDefault seccomp, mount no service account token, and run tini as
PID 1. CPU and memory requests equal the limits. They carry the label
`baskule.computer: "true"`, which the chart's NetworkPolicy selects. No chart workload or
computer pod runs privileged, uses host networking, or mounts a Docker socket.

With `computers.prePull.enabled`, the `<release>-computer-prepull` DaemonSet keeps the
computer image on every node matching `computers.nodeSelector` and `computers.tolerations`.
Computers on Docker start in about a second on a warm host; on Kubernetes cold start
is dominated by image pull, which the pre-pull DaemonSet removes.

`computers.runtimeClassName` selects an installed RuntimeClass, such as GKE Sandbox's
`gvisor`. It is optional, and no RuntimeClass has been verified with Baskule computers.
Run a successful computer journey before relying on one.

## Isolation and network rules

With `networkPolicy.enabled` (the default), the chart adds these NetworkPolicies:

- celld accepts Worker traffic on port 47091 from any source, and peer traffic on 47092
  only from celld pods and the deploy job.
- computerd accepts port 47094 only from celld pods.
- Computer pods accept no ingress. They may send only:
  - DNS (UDP and TCP 53) to kube-dns and NodeLocal DNSCache (`k8s-app: node-local-dns`) pods in
    `kube-system`, and to `computers.dnsServerCidrs`;
  - IPv4 traffic to `0.0.0.0/0` except private (`10.0.0.0/8`, `172.16.0.0/12`,
    `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), link-local (`169.254.0.0/16`, including
    cloud metadata), loopback, `0.0.0.0/8`, multicast and reserved ranges, and the IPv4
    entries of `computers.blockedCidrs`;
  - with `computers.ipv6: true`, IPv6 traffic to `::/0` except unique-local, link-local,
    loopback, multicast and the IPv6 entries of `computers.blockedCidrs`. Otherwise
    computers have no IPv6 egress.

The CNI must enforce NetworkPolicy; otherwise none of these rules apply. NetworkPolicies
are additive: do not add a broad egress allow that selects computer pods. Add every
publicly addressed Pod, Service, node, storage or organization range that computers must
not reach to `computers.blockedCidrs`. The kind journey's storage denial check covers only
its test-only in-cluster S3 fixture; it does not prove denial of an external S3 provider.

GKE's NodeLocal DNSCache with Dataplane V2 is covered by the pod rule. A cluster whose
resolver is neither of those pods, such as a host-network DNS cache, answers from an address
the pod rules do not match. Set `computers.dnsServerCidrs` to
the `nameserver` addresses in a pod's `/etc/resolv.conf`, as `/32` CIDRs; computers may
reach them only on port 53. computerd uses the same cluster DNS, so
`kubectl -n baskule exec deploy/baskule-computerd -- cat /etc/resolv.conf` shows them.

Plugin MCP requests originate in celld, not computers, so the computer policy does not
govern plugin connections.

Disabling `networkPolicy.enabled` removes all of these rules, including the computer
egress restrictions, and is unsuitable for a shared cluster.

## Scaleway Object Storage

This bucket recipe works with GKE or another Kubernetes cluster; it does not require
Scaleway compute. Use an authenticated `scw` CLI (verified with v2.65.2), `jq`, and
an operator identity allowed to create a bucket and IAM application/policy/API key.
Choose an existing dedicated Scaleway project for Baskule. The IAM rule below grants
Object Storage access to **that whole project**, not just one bucket. See Scaleway's
[permission sets](https://www.scaleway.com/en/docs/iam/policies-permissions/permission-sets/)
and [IAM and bucket policy guidance](https://www.scaleway.com/en/docs/object-storage/api-cli/combining-iam-and-object-storage/).

```sh
export SCW_DEFAULT_ORGANIZATION_ID=your-organization-uuid
export SCW_DEFAULT_PROJECT_ID=your-dedicated-storage-project-uuid
export SCW_DEFAULT_REGION=fr-par
export BASKULE_BUCKET="baskule-$(date -u +%s)" # globally unique; save this name
scw object bucket create "$BASKULE_BUCKET" \
  project-id="$SCW_DEFAULT_PROJECT_ID" region=fr-par \
  tags.0=app=baskule tags.1=baskule-install="$BASKULE_BUCKET"

set +x # never trace credentials
umask 077
private=$(mktemp -d)
scw iam application create name=baskule-storage \
  organization-id="$SCW_DEFAULT_ORGANIZATION_ID" -o json > "$private/application.json"
application=$(jq -r .id "$private/application.json")
scw iam policy create name=baskule-storage application-id="$application" \
  organization-id="$SCW_DEFAULT_ORGANIZATION_ID" \
  rules.0.project-ids.0="$SCW_DEFAULT_PROJECT_ID" \
  rules.0.permission-set-names.0=ObjectStorageFullAccess -o json > "$private/policy.json"
scw iam api-key create application-id="$application" \
  default-project-id="$SCW_DEFAULT_PROJECT_ID" description=baskule-storage \
  -o json > "$private/key.json"
jq -rj .access_key "$private/key.json" > "$private/AWS_ACCESS_KEY_ID"
jq -rj .secret_key "$private/key.json" > "$private/AWS_SECRET_ACCESS_KEY"
```

Store the key and identity/policy IDs in your secret manager. Keep the private files
until you [create the Kubernetes Secret](#create-the-kubernetes-secret) after cluster
creation. This application credential recipe is documented from the CLI/API. The
completed GKE run used the operator's general Scaleway key in celld and did not
exercise the application-key recipe. Future runs require a separate dedicated
application key limited to Object Storage. Never give that application IAM
management permissions.

Set these values alongside your chosen `publicUrl` and exposure settings:

```yaml
s3:
  endpoint: https://s3.fr-par.scw.cloud
  region: fr-par
  bucket: REPLACE_WITH_BASKULE_BUCKET
  existingSecret: baskule-bucket
```

For GKE, create the cluster below, create the Kubernetes Secret, then use the Helm
install command above. GKE `europe-west1` to Scaleway `fr-par`
crosses providers: storage latency and egress apply. Measured journey timings include
that path. A private cluster needs outbound access to this storage endpoint as well
as image registries and model providers. Apply the private-endpoint and egress
guidance above before production use.

## GKE Standard

These commands follow Google's [zonal cluster guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/creating-a-zonal-cluster).
This is the cloud path that `e2e/kubernetes-ephemeral.sh` exercises, with Ubuntu
containerd, Dataplane V2, two Spot nodes with 4 vCPU and 8 GiB each, and a disposable
Scaleway bucket. Its journey covers setup, an S3 conditional-write check, fake chat,
computer execution, stop/start and cross-node PVC persistence, NetworkPolicy denial
including GKE metadata, public HTTPS and TCP 22 egress, CDP, VolumeSnapshot restore,
celld takeover, space/PVC deletion, public WebSocket and HTTP/SSE transport streaming past
65 seconds, and same-version Helm upgrade with stable platform and storage secrets. TLS
remains unverified. Earlier computer-journey runs used the former in-cluster storage
fixture and do not by themselves verify external storage; see the
[storage conformance record](storage-conformance.md).

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

Dataplane V2 provides NetworkPolicy enforcement. Use the cluster's block-backed default
StorageClass. With Dataplane V2, `ipBlock` rules never match pod traffic, so the DNS pod
rules above, not `computers.dnsServerCidrs`, allow NodeLocal DNSCache.
Choose non-overlapping RFC 1918 Pod and Service ranges before creating the cluster.
GKE's Google-managed `34.118.224.0/20` Service range is public address space, which the
chart's computer policy does not exclude. If a cluster uses it, or any other publicly
addressed Pod, Service or node range, add those ranges to `computers.blockedCidrs`.
For a private cluster, provide outbound image-registry and model-provider access.

### Create the Kubernetes Secret

After the target cluster exists and kubectl selects that cluster, check its context:

```sh
kubectl config current-context
```

For the GKE commands above, the context is `gke_${GKE_PROJECT}_europe-west1-b_baskule`.
Do not continue if the selected context points at another cluster. Use the private
files from the Scaleway application-key recipe to create the Secret:

```sh
kubectl create namespace baskule
kubectl -n baskule create secret generic baskule-bucket \
  --from-file=AWS_ACCESS_KEY_ID="$private/AWS_ACCESS_KEY_ID" \
  --from-file=AWS_SECRET_ACCESS_KEY="$private/AWS_SECRET_ACCESS_KEY"
rm -rf "$private"
```

Install Agent Sandbox, then install the chart with the S3 values above.

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

Target Standard, with a native containerd runtime. Autopilot has not been verified.
GKE Sandbox (gVisor) can be selected with `computers.runtimeClassName: gvisor` on a GKE
Sandbox node pool; like any RuntimeClass, it is optional and unverified with Baskule computers.

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

## Values

The [checked-in values](../deploy/helm/baskule/values.yaml) are the full reference and
[values.schema.json](../deploy/helm/baskule/values.schema.json) rejects unknown keys.
The settings are:

| Value | Default | Purpose |
| --- | --- | --- |
| `publicUrl` | `http://localhost:47090` | Public origin, setup link and route host |
| `replicas` | `2` | celld nodes, stable pod names and peer DNS |
| `global.image.registry` | `ghcr.io/baskule` | Registry of the celld, computerd and computer images |
| `global.image.tag` | chart version | Image tag |
| `global.image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `imagePullSecrets` | `[]` | Registry Secrets for celld, computerd and the deploy job |
| `existingSecret` | generated once | `COMPUTERD_TOKEN`, `SETUP_TOKEN`, `PLUGIN_SYNC_TOKEN` |
| `authConfig` | password sign-in | Authentication JSON; see [installation settings](installation-settings.md) |
| `s3.endpoint` | external endpoint required | Shared celld storage |
| `s3.region`, `s3.bucket` | `us-east-1`, bucket required | Bucket region and name |
| `s3.existingSecret` | empty | Operator-owned S3 Secret; preferred for GitOps |
| `s3.accessKeyId`, `s3.secretAccessKey` | empty | External S3 keys, applied on each upgrade when no existing Secret |
| `celld.resources` | 250m/512Mi requested, 2 CPU/2Gi limit | celld pod resources |
| `celld.heapLimitMb` | `1024` | celld V8 heap limit |
| `celld.terminationGracePeriodSeconds` | `50` | Time for a stopping celld pod to hand off cells (minimum 40) |
| `computerd.resources` | 100m/128Mi requested, 512Mi limit | computerd pod resources |
| `exposure.mode` | `none` | `none`, `ingress`, or `gateway` |
| `exposure.serviceAnnotations` | `{}` | Worker Service annotations for the selected controller |
| `exposure.ingress.className`, `exposure.ingress.annotations`, `exposure.ingress.tls` | empty | Ingress class, annotations merged over the nginx defaults, TLS |
| `exposure.gateway.name`, `exposure.gateway.namespace`, `exposure.gateway.sectionName` | empty | Parent Gateway of the HTTPRoute |
| `networkPolicy.enabled` | `true` | Chart NetworkPolicies, including computer egress rules |
| `computers.image` | empty | Computer image override; empty uses the release image |
| `computers.cpus`, `computers.memory` | `"2"`, `3Gi` | Per-computer CPU and memory request and limit |
| `computers.diskSize` | `10Gi` | New computer PVC capacity |
| `computers.storageClass` | empty | New computer PVC StorageClass; empty uses the cluster default |
| `computers.runtimeClassName` | empty | Optional installed RuntimeClass |
| `computers.nodeSelector` | `{}` | Computer and pre-pull node labels |
| `computers.tolerations` | `[]` | Computer and pre-pull tolerations |
| `computers.imagePullSecrets` | `[]` | Computer and pre-pull registry Secrets, objects with `name` |
| `computers.prePull.enabled` | `true` | DaemonSet pre-pulls the computer image |
| `computers.dnsServerCidrs` | `[]` | Extra resolvers computers may reach on port 53 |
| `computers.blockedCidrs` | `[]` | Extra IPv4/IPv6 destinations blocked for computers |
| `computers.ipv6` | `false` | Allow public IPv6 egress with exclusions |

Supply private registry credentials through both `imagePullSecrets` and
`computers.imagePullSecrets` as needed. `authConfig` is stored in the Helm release:
keep values containing SSO client secrets private.
The generated platform Secret uses Helm lookup to preserve its tokens on upgrade.
Chart-managed platform and S3 Secrets are retained on uninstall. Supplied S3 values
replace the managed S3 Secret's keys on upgrade; `s3.existingSecret` remains operator-owned.
Moving buckets also requires copying bucket data before switching values; changing
credentials alone does not move data. Pods read keys at startup. For a credentials-only
change, run `kubectl -n baskule rollout restart statefulset/baskule-celld` after updating
the Secret.

GitOps (`helm template`, ArgoCD) and client-side dry runs cannot use server lookup
to retain generated platform tokens. Set `existingSecret` for those workflows and
manage the three platform tokens outside Helm. S3 keys are supplied values, so
repeated rendering does not generate new S3 keys. Prefer `s3.existingSecret` to keep
those credentials outside Helm values and rendered manifests.
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
a version upgrade.
New computer images and settings apply only to computers created afterwards.

The hook deploys the Worker and asks every configured celld node to reload it. celld
pods update one at a time and have 50 seconds to hand off cells. App deployment is not
an atomic rollback of bucket state: `helm rollback` alone cannot undo a deployed bundle.

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --reset-then-reuse-values --values values.yaml --set replicas=3 --wait --timeout 10m
```

Use Helm for scaling so the reload target list tracks the replica count. Persist that
count in `values.yaml`. Computer scheduling follows Kubernetes capacity; the platform
continues to use one computerd Service. computerd has one replica. Restarting it
interrupts active exec, file and CDP streams; running computers continue, and computerd
adopts them when it starts.

## Back up and restore

Back up the whole celld bucket, the Helm values and chart version, the platform and S3
Secrets (`baskule-secrets` and `baskule-s3`, or your existing Secrets), and every computer
PVC with your CSI VolumeSnapshot provider. Restoring the bucket alone does not restore
computer files. Keep snapshots outside the lifecycle of a disposable installation.

For a consistent recovery point, stop incoming traffic and scale celld and computerd to zero:

```sh
kubectl -n baskule scale statefulset/baskule-celld deployment/baskule-computerd --replicas=0
```

Then suspend each running computer by setting its Sandbox's `spec.operatingMode` to
`Suspended`, and wait until no pod labelled `baskule.computer=true` remains. Keep the
Sandboxes and PVCs. Take CSI VolumeSnapshots of the computer PVCs with your provider's
VolumeSnapshotClass, recording each PVC's name, `accessModes`, `storageClassName` and
`resources`. Then copy the entire bucket into a separately protected backup and keep the
Secrets with that recovery point. Restart computerd at one replica and celld at the count
in your values; computers resume on next use. Do not take a live filesystem copy of a
running computer as a substitute for this procedure.

To return to a recovery point in the same cluster, keep traffic stopped, restore the
bucket and Secrets, start computerd only, restore each computer disk with the procedure
below, then start celld. Verify chat history and computer file bytes before reopening
traffic. Only the single-disk restore is verified: `e2e/kubernetes-journey.mjs` asserts it
on GKE with the PD CSI driver by comparing file hashes after restore. Other CSI drivers
need their own restore check. Do not treat these snapshots as a verified cross-cluster
disaster-recovery procedure.

To restore one computer disk, preserve the space identity and follow these steps. The
cluster needs the VolumeSnapshot CRDs and a CSI driver that supports snapshots.
Call computerd's [API](../computerd/README.md#api) with bearer `COMPUTERD_TOKEN`. Its
NetworkPolicy admits only celld pods; from an operator machine, use
`kubectl -n baskule port-forward svc/baskule-computerd 47094`.

1. Record the Sandbox and its PVC name `<disk>-<sandbox>`, plus the PVC's
   `accessModes`, `storageClassName` and `resources`. Record hashes of known files.
2. Stop the computer with `POST /v1/spaces/:id/computer/stop` and prevent concurrent
   ensures. Create a `snapshot.storage.k8s.io/v1` VolumeSnapshotClass for your CSI driver
   (the GKE journey uses `pd.csi.storage.gke.io`) and a VolumeSnapshot whose
   `spec.source.persistentVolumeClaimName` is that PVC. Wait for `status.readyToUse`.
3. With the backup secured, delete the computer through
   `POST /v1/spaces/:id/computer/delete` with body `{"confirm":"<spaceId>"}` and
   bearer `COMPUTERD_TOKEN`. This deletes the Sandbox and original disk. Confirm
   that the PVC is absent before proceeding.
4. Create a PVC in the same namespace with exactly the original name, the recorded
   access modes, StorageClass and resource request, and label
   `agents.x-k8s.io/adoptable: "true"`. Set `spec.dataSource` to
   `{apiGroup: snapshot.storage.k8s.io, kind: VolumeSnapshot, name: <snapshot-name>}`.
   Do not copy old `ownerReferences`, UIDs or resource versions.
5. Only then call `POST /v1/spaces/:id/computer/ensure`. Agent Sandbox adopts the
   restored PVC. Verify file hashes before allowing users back in or deleting backups.

## Uninstall

```sh
helm uninstall baskule --namespace baskule
```

Helm keeps generated Secrets. The external bucket is untouched. Sandboxes created by
computerd, with their pods and PVCs, also remain unless
you explicitly delete them, while uninstall removes the chart's NetworkPolicies. Stop or
delete computers before uninstalling. Preserve backups first. To erase a disposable
installation, delete its Sandboxes, uninstall the chart, then delete its PVCs and retained
Secrets. Deleting a Sandbox also removes the PVCs it owns. Check the CSI provider's reclaim
policy and cloud inventory for retained disks before deleting the cluster. The
cluster-wide Agent Sandbox controller may serve other installations; do not remove it
automatically.

## Verify a source change

First build as described in [Build server, web, and images](building.md#build-server-web-and-images)
with `deploy/build.sh --no-deploy`. This builds the web app, SpaceCell, platform bundle
and the `:local` computer, celld and computerd images without starting an installation.
Then bake the current platform bundle into the release celld target and tag the three
Kubernetes images explicitly. `scripts/check release` runs the same Kubernetes check and
needs the same images.

```sh
source scripts/env.sh
scripts/docker-build.sh celld --network host --target release -t baskule-celld:kubernetes -f deploy/celld/Dockerfile .
for image in computerd computer; do
  docker tag "baskule-$image:local" "baskule-$image:kubernetes"
done
scripts/check kubernetes
```

The local check needs kind, kubectl and Helm. It creates a kind cluster with Calico,
Agent Sandbox and a test-only RustFS fixture outside the chart, using a 1-CPU/1-GiB
computer so it can run on a two-CPU CI host.
The cloud run uses the production computer defaults. The journey runs setup, a bucket
conditional-write check, fake chat, computer exec, stop/start persistence, pod
replacement, network isolation, CDP, celld takeover, space/PVC deletion, and a
credential-preserving Helm upgrade. Network isolation checks that computers reach DNS,
public HTTPS and public TCP 22, and cannot reach celld peers, platform Services, computerd,
the S3 fixture, the Kubernetes API, the kubelet or metadata addresses. kind's default local PVCs
stay on one node. The upgrade step re-applies the same chart/images and asserts generated
token stability and hook success. A separate two-version rendering fixture packages the
real defaults/image helper at 1.0.0 and 2.0.0, then verifies the documented merge selects
tag 2.0.0 without launching those fictitious images. This does not prove application
behavior across releases or schema migration. Evidence stays under `.run/evidence/`.

Only with the installation owner's authorization, authenticate gcloud and set
`BASKULE_GKE_PROJECT` to the authorized active project. Build the three images as above,
then run `BASKULE_K8S_TAG=kubernetes e2e/kubernetes-ephemeral.sh run`; the tag is required so a
run never ships another checkout's images, and the IDs it pushes are recorded in `images.txt`. Every gcloud operation selects that project
explicitly; the script does not change the account or project configuration.
It creates two Spot `e2-custom-4-8192` nodes in `europe-west1-b`, an ephemeral Artifact
Registry repository, a disposable node service account, a reserved address and a real
GKE Ingress. It pushes the packaged chart to that OCI repository and installs it by
version. It disables pre-pull so the first computer starts on a cold node, forces a
computer onto another node with the same block volume, restores a VolumeSnapshot into
the original PVC name, and checks GKE metadata isolation. Public checks exercise product
WebSocket chat and a separate HTTP/SSE transport probe that reuses the fake LLM behind the
same Ingress. Afterwards it runs computerd's integration suite inside the computerd pod
and a lifecycle and exec benchmark, recording both as evidence.

The script records node-hours under `.run/evidence/` and enforces a 90-minute lifetime
plus teardown time. Its EXIT/INT/TERM trap deletes the cluster, repository, node identity
and remaining owned disks or load-balancer resources. Resources carry
`baskule-ephemeral=true` and `baskule-run=<run-id>` where their APIs support labels.
Other GKE-managed resources carry the unique run name in their names or descriptions.
The cleanup audit includes tagged Scaleway buckets and detects disks and load-balancer resources added since the run's
baseline. Run `e2e/kubernetes-ephemeral.sh sweep` after an interrupted host session,
or a lifetime/cleanup timeout, then `audit`. Kubernetes cleanup is bounded to eight
minutes, each API request is bounded, and cluster deletion is attempted even if that
phase times out. Teardown ignores repeated interrupts and gets up to 30 additional
minutes before a hard kill. A Git-common-directory lock is shared across worktrees of this repository: global
sweep refuses while a worker holds that project lock. It also refuses if any labelled
cluster, Artifact Registry repository or tagged Scaleway bucket is younger than 120 minutes, or its creation
time is unknown. This age guard covers other checkouts/machines; it is not a live
process detector. `sweep --force` bypasses both guards only for deliberate recovery.
Never publish kubeconfigs, private inventory, Helm notes or raw payloads.
To repeat only public Ingress and Helm-upgrade verification after the core journey
passes on the same chart and images, set `BASKULE_K8S_JOURNEY=ingress` for the run.
Use `BASKULE_K8S_JOURNEY=failover` after the full journey passes on the same images. It
prepares chat and file data, repeats configured public exposure, celld takeover,
space/PVC deletion and the Helm upgrade, and skips stop/start, pod replacement,
isolation, CDP and snapshot checks. Set `BASKULE_K8S_JOURNEY=upgrade` to repeat only
install, server-side credential rendering and same-version upgrade checks. Set
`BASKULE_K8S_CHECK_INGRESS=0` to skip the public Ingress probes.
For the ephemeral run, privately export `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, and
`SCW_DEFAULT_PROJECT_ID` for host-side bucket provisioning and cleanup. Separately
export `BASKULE_S3_ACCESS_KEY` and `BASKULE_S3_SECRET_KEY` from a dedicated application
with only the Object Storage policy on that project. The runner refuses to start
without both application-key variables. Only those application credentials enter
the cluster, through `kubectl create`, without a last-applied annotation. The
`SCW_*` provisioning credentials stay on the host. The runner does not create IAM
applications, policies or keys. The operator must provision the scoped application
before the run, as in the recipe above.

The completed GKE run used the operator's general key in celld. That historical
storage/journey evidence does not verify the new application-key requirement or
recipe. The credential separation is covered by local regression tests; no new
cloud run was performed for this review fix.

The runner requires `scw` v2.65.2 and Python `boto3`
(`python3 -m pip install boto3` in your chosen environment). Each run creates a private,
versioning-suspended `baskule-ephemeral-<run-id>` bucket tagged `baskule-ephemeral=true`
and `baskule-run=<full bucket name>` in `fr-par`. Cleanup empties all objects and
aborts multipart uploads before deleting the bucket. Sweep uses ownership tags or
an exact bucket name recorded before creation, confined to the GCP and Scaleway
projects. The exact-name record also covers a create/tag failure that leaves an
untagged bucket. The audit checks those names too. Unrelated buckets are never
deleted. A bucket failure does not stop GCP cleanup; the final audit still fails
if bucket absence cannot be verified. The 90-minute run
bound, shared live-run lock and 120-minute global sweep guard cover the bucket too.
No GCS buckets, HMAC credentials or org-policy changes are used.

The GKE runner requires the SDK's `docker-credential-gcloud` helper and uses a private
shared Docker/Helm helper configuration so long runs can renew registry credentials.

## Limits

The celld Worker port 47091 currently accepts ingress from all sources allowed by
the cluster network. Only the peer and computerd ports have source restrictions.
Restricting Worker ingress to trusted controller/load-balancer sources remains open:
source identities and health-check ranges vary between controllers, and GKE can
rewrite source addresses. Operators must add controller-specific NetworkPolicy or
firewall rules after verifying the observed sources. This chart does not claim
Worker source isolation.

Existing chart installs that used `rustfs.enabled` must be reinstalled with a cloud
bucket; the retired values are rejected. There is no migration. Back up first, stop
traffic, uninstall the release, provision a new bucket and credentials, then reinstall
in a fresh namespace with the new values, Secrets and PVCs. A fresh bucket starts
with no prior accounts, chats, files stored
in celld, or settings. Retained PVCs/Secrets in the old namespace are not read by the new install;
delete them only after deciding to discard their data. Existing computer PVCs
alone do not restore the celld spaces that used them.

The chart does not migrate a Compose installation and changes no data in an existing
Compose install. computerd high availability, controller installation, model-provider
credentials, TLS automation, and multi-zone storage failover are outside this chart.
Volumes can move only where the selected StorageClass permits. Only `/sandbox/space`
persists; existing computers keep the image they were created with when the computer
image changes. EKS, AKS, Kapsule, alternative Ingress/Gateway controllers, RuntimeClasses
and full disaster recovery need their own verification.
