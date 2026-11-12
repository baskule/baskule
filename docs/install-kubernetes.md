# Install a Baskule cluster on Kubernetes

The Helm chart runs celld as a StatefulSet and computerd as a Deployment. Each space's
computer runs as an Agent Sandbox `Sandbox` with a persistent disk. For a single-machine
installation, see [Install Baskule](install.md).

## Prerequisites

Use a supported Kubernetes release with API-server support for WebSocket exec protocol
`v5.channel.k8s.io`. Kubernetes 1.31 enables the required streaming support by default;
see the [upstream WebSocket requirements](https://kubernetes.io/blog/2024/08/20/websockets-transition/).
Install a compatible kubectl and Helm 3.16 or newer (for `--reset-then-reuse-values` and the chart's Kubernetes 1.31 requirement).
Local source verification also requires Docker, kind, Python 3, and jq.

Prepare these cluster resources:

- Linux amd64 worker nodes with capacity for platform pods and concurrent computers.
  Each computer requests and limits 2 CPU and 3 GiB by default.
- A CNI that enforces ingress and egress NetworkPolicy.
- A block-backed CSI StorageClass supporting ReadWriteOnce volumes. Set it as the cluster
  default or name it in `computers.storageClass`. Nodes must be in zones where these volumes can attach.
- An external S3-compatible bucket with [atomic conditional writes](storage-conformance.md).
  The chart does not provision a bucket or include an object store.
- Agent Sandbox CRDs and controller. Installing these cluster-wide resources requires
  cluster administration privileges; the chart creates only namespaced resources.

Install the controller version used by Baskule's checks:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox.yaml
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
```

Use a dedicated namespace. Creating computerd's Role requires the permissions it grants
or the RBAC `escalate` permission. Install any Ingress or Gateway controller, Gateway API
CRDs, DNS records, and TLS certificates separately.

## Create the Kubernetes Secret

Check that kubectl selects the intended cluster, then create the namespace:

```sh
kubectl config current-context
kubectl create namespace baskule
```

Supply bucket credentials through a secret manager or an untracked private file. This
example shows the required Secret keys. Replace the placeholders and keep the result private:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: baskule-bucket
  namespace: baskule
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: REPLACE_WITH_BUCKET_ACCESS_KEY
  AWS_SECRET_ACCESS_KEY: REPLACE_WITH_BUCKET_SECRET_KEY
```

Create the Secret from your private file, for example
`kubectl create -f /secure/path/bucket-secret.yaml`.

Grant the credential access only to the installation's bucket. Keep credentials out of
shell history and Helm values. `s3.existingSecret` selects this Secret without embedding
its keys in the Helm release. The bucket must enforce `If-Match` and `If-None-Match`;
ordinary upload/download support does not establish compatibility.

## Install the chart

Save the following as `values.yaml`, replacing the origin, endpoint, region, bucket,
and StorageClass with your installation's values:

```yaml
publicUrl: https://baskule.example.com
s3:
  endpoint: https://s3.storage.example.com
  region: us-east-1
  bucket: baskule
  existingSecret: baskule-bucket
computers:
  storageClass: block-storage
exposure:
  mode: none
```

Select a published chart version from [Baskule Releases](https://github.com/baskule/baskule/releases).
Replace `X` with that version without a leading `v`:

```sh
helm install baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --values values.yaml --timeout 10m
```

Do not add `--wait` to the first install: celld becomes ready after the post-install
hook deploys the application. Open the private setup link printed by Helm and create
the first administrator. Configure your model provider in Administration.

Keep the release name and namespace stable. Computer and disk names derive from the
release name, and computerd discovers resources in its namespace. After installation,
check the bucket using the pod's configured credentials:

```sh
kubectl -n baskule exec baskule-celld-0 -- sh -ec 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"'
```

The `bucket conditional write` check must report `ok`.

## Expose the application

`publicUrl` is the origin, including scheme and optional port, without a path. Its host
becomes the Ingress or HTTPRoute host. Ingress and Gateway modes reject loopback origins.
Use HTTPS for public installations.

For local evaluation, set `publicUrl: http://localhost:47090` and `exposure.mode: none`, then run:

```sh
kubectl -n baskule port-forward svc/baskule 47090:80
```

For an installed Ingress controller, configure its class, TLS, and controller-specific annotations:

```yaml
exposure:
  mode: ingress
  ingress:
    className: your-ingress-class
    annotations: {}
    tls:
      - hosts: [baskule.example.com]
        secretName: baskule-tls
```

The chart includes nginx annotations for 1 GiB bodies, disabled request and response
buffering, and 3600-second read/send timeouts. Other controllers need equivalent
configuration; nginx annotations have no effect on them. The community ingress-nginx
controller [is retired](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/).
Choose a maintained controller for a new installation.

For an existing Gateway with an HTTPS listener, configure:

```yaml
exposure:
  mode: gateway
  gateway:
    name: public
    namespace: gateway-system
    sectionName: https
```

The chart creates an HTTPRoute with 3600-second request and backend timeouts. The
Gateway listener must accept routes from the Baskule namespace. Configure TLS,
upload limits, buffering, and WebSocket support on the controller separately.
`exposure.serviceAnnotations` applies controller-specific annotations to the Worker Service.

Verify WebSocket upgrades, immediate SSE/NDJSON delivery, uploads up to 1 GiB, and
streams lasting longer than the controller's default timeout. The chart's nginx annotations
set this upload limit; configure the equivalent on other controllers.
An accepted route or healthy backend alone does not prove these behaviors.

Client IP handling depends on the proxy's forwarded headers. celld trusts forwarded
headers, and Baskule currently takes the last X-Forwarded-For entry. A proxy that appends
its own address puts all users in one authentication rate-limit bucket: 10
`/sign-in/email` requests per 60 seconds and 200 auth requests per minute. Successful
sign-ins count toward that limit, so the 11th sign-in in a minute returns 429 for everyone.
Google's managed HTTP load balancer [appends a forwarding-rule IP](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header), so that topology is
unsuitable for production until per-client handling is implemented and verified.
Verify your controller's header behavior and forged-header resistance before public use.

## Computers

computerd uses ServiceAccount `<release>-computerd` and a namespaced Role that manages
Sandboxes, reads pods, accesses `pods/exec` and `pods/portforward`, and reads/deletes PVCs.
It is the only chart pod that mounts a service account token. That Role can exec into
any pod in the namespace, so keep unrelated workloads out of it.

Each Sandbox uses `agents.x-k8s.io/v1beta1`. Its volumeClaimTemplate creates a
ReadWriteOnce PVC named `<disk>-<sandbox>`, mounted at `/sandbox/space`. Only that directory
persists. The rest of the filesystem resets when a pod is recreated, including stop/start.
Suspension sets `spec.operatingMode: Suspended`; the next use resumes it. Exec and CDP
connections travel through the Kubernetes API WebSocket.

Computer pods run as UID/GID 1000, drop all capabilities, disable privilege escalation,
use RuntimeDefault seccomp, and mount no service account token. CPU/memory requests equal
the limits. No chart pod uses privileged mode, host networking, or a Docker socket.

On next start, stopped computers with a changed image reference or CPU/memory limits
receive a new pod template and retain their PVC. Running computers keep their current
configuration. Scheduling changes alone do not trigger replacement. Existing PVC sizes
and StorageClasses remain unchanged. Use immutable image tags: Kubernetes compares
image references, whereas the Docker backend compares image IDs.

`computers.prePull.enabled` defaults to true. Its DaemonSet caches the computer image
on nodes matching `computers.nodeSelector` and `computers.tolerations`.
`computers.imagePullSecrets` applies to both computers and pre-pulling; `imagePullSecrets`
separately applies to platform pods and the deploy job. `computers.runtimeClassName`
selects an installed RuntimeClass; verify a computer journey with that runtime before use.

## Isolation and network rules

Prefer RFC 1918 Pod and Service CIDRs, and add any publicly addressed cluster range to
`computers.blockedCidrs`. For example, GKE's [managed Service range](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/alias-ips)
`34.118.224.0/20` uses non-RFC 1918 addresses that the computer policy does not exclude by default.

Keep `networkPolicy.enabled: true` with an enforcing CNI:

- celld accepts Worker traffic on 47091 from any source. Peer port 47092 admits only
  this release's celld and deploy pods.
- computerd port 47094 admits only this release's celld pods.
- Computers accept no ingress. DNS egress on TCP/UDP 53 reaches kube-dns and
  NodeLocal DNSCache pods in `kube-system`, plus `computers.dnsServerCidrs`.
- Computer IPv4 egress permits public destinations but excludes private, CGNAT,
  link-local, loopback, multicast, reserved ranges, and `computers.blockedCidrs`.
  IPv6 egress is disabled unless `computers.ipv6: true`; it then excludes unique-local,
  link-local, loopback, multicast, and configured IPv6 blocked CIDRs.

NetworkPolicies are additive. A broad allow policy selecting computers can defeat these
restrictions. Add publicly addressed Pod, Service, node, storage, and organization ranges
that computers must not reach to `computers.blockedCidrs`. NetworkPolicy cannot block a
DNS name. Computers receive no S3 credentials, but can reach public storage addresses
unless you block their CIDRs or use a private endpoint.

The NodeLocal DNSCache pod rule also covers GKE Dataplane V2, where `ipBlock` does not
match pod traffic. For other DNS caches, set `computers.dnsServerCidrs` to the actual
resolver addresses as `/32` or `/128` CIDRs. Inspect the cluster resolver with:

```sh
kubectl -n baskule exec deploy/baskule-computerd -- cat /etc/resolv.conf
```

Plugin MCP requests originate in celld, so computer egress rules do not govern them.
Worker source isolation requires additional controller-specific NetworkPolicy or firewall
rules based on observed source and health-check addresses. The chart does not restrict
Worker ingress to trusted proxies.

## Values

[values.yaml](../deploy/helm/baskule/values.yaml) lists every setting and default.
[values.schema.json](../deploy/helm/baskule/values.schema.json) rejects unknown keys.
The defaults below describe the source chart; release packaging sets its image tag to
the packaged version.

| Key | Default | Meaning |
| --- | --- | --- |
| `publicUrl` | `http://localhost:47090` | Public origin, setup link, and route host |
| `replicas` | `2` | celld replicas and deploy-hook reload targets |
| `global.image.registry` | `ghcr.io/baskule` | Platform and default computer image registry |
| `global.image.tag` | `"0.0.0"` | Replaced with the chart version during release packaging |
| `global.image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `imagePullSecrets` | `[]` | Registry Secrets for celld, computerd, and deploy jobs |
| `existingSecret` | `""` | Platform token Secret; empty generates `<release>-secrets` |
| `authConfig` | `{"version":1,"mode":"authenticated","password":true}` | Authentication JSON; see [installation settings](installation-settings.md) |
| `s3.endpoint`, `s3.bucket` | `""` | Required external S3 endpoint and existing bucket |
| `s3.region` | `us-east-1` | S3 signing region |
| `s3.existingSecret` | `""` | Existing bucket-credential Secret |
| `s3.accessKeyId`, `s3.secretAccessKey` | `""` | Required when no existing S3 Secret is selected |
| `celld.resources` | Request 250m CPU/512Mi; limit 2 CPU/2Gi | celld pod resources |
| `celld.heapLimitMb` | `1024` | V8 heap limit in MiB |
| `celld.terminationGracePeriodSeconds` | `50` | Cell handoff grace; minimum 40 seconds |
| `computerd.resources` | Request 100m CPU/128Mi; limit 512Mi | computerd pod resources |
| `exposure.mode` | `none` | Port-forward, `ingress`, or `gateway` exposure |
| `exposure.serviceAnnotations` | `{}` | Worker Service annotations |
| `exposure.ingress.className`, `exposure.ingress.annotations`, `exposure.ingress.tls` | `""`, `{}`, `[]` | Ingress class, overrides for nginx annotation defaults, and TLS |
| `exposure.gateway.name`, `exposure.gateway.namespace`, `exposure.gateway.sectionName` | `""` | Parent Gateway and optional namespace/listener; name required in gateway mode |
| `networkPolicy.enabled` | `true` | Chart ingress and computer egress policies |
| `computers.image` | `""` | Empty uses the release computer image |
| `computers.cpus`, `computers.memory` | `"2"`, `3Gi` | Per-computer CPU/memory requests and limits |
| `computers.diskSize` | `10Gi` | Capacity for new PVCs only |
| `computers.storageClass` | `""` | New PVC StorageClass; empty selects the cluster default |
| `computers.runtimeClassName` | `""` | Optional installed RuntimeClass |
| `computers.nodeSelector`, `computers.tolerations` | `{}`, `[]` | Computer and pre-pull scheduling |
| `computers.imagePullSecrets` | `[]` | Computer and pre-pull registry Secrets |
| `computers.prePull.enabled` | `true` | Cache the computer image with a DaemonSet |
| `computers.dnsServerCidrs` | `[]` | Additional DNS resolvers allowed on port 53 |
| `computers.blockedCidrs` | `[]` | Additional IPv4/IPv6 destinations denied to computers |
| `computers.ipv6` | `false` | Enable public IPv6 egress with exclusions |

Helm generates `COMPUTERD_TOKEN` and `SETUP_TOKEN` once, preserving
them with server lookup on upgrades. For GitOps or repeated client-side rendering, set
`existingSecret` to a Secret containing those two keys and manage it separately.
Client-side rendering cannot preserve generated tokens through lookup. Verify your
GitOps controller's hook ordering before relying on it.

Without `s3.existingSecret`, both `s3.accessKeyId` and `s3.secretAccessKey` are required
and reapplied on upgrades. Prefer an existing Secret. Pods read keys at startup; after a
credentials-only Secret change, restart the celld StatefulSet. Moving buckets requires
copying the complete bucket before switching values. Keep `authConfig` values containing
SSO client secrets private because Helm retains the values.

## Upgrade and scale

Back up the installation, update the saved values, then upgrade:

```sh
helm upgrade baskule oci://ghcr.io/baskule/charts/baskule --version X \
  --namespace baskule --reset-then-reuse-values --values values.yaml --wait --timeout 10m
```

`--reset-then-reuse-values` merges your overrides onto new defaults, including the new
image tag. Plain `--reuse-values` retains the previous default tag. An explicit
`global.image.tag` stays pinned until you update or remove it.

Set `replicas` in the saved values and use Helm to scale so the deploy hook's reload
list follows the replica count. celld updates one pod at a time. computerd has one replica;
its restart interrupts active exec, file, and CDP streams, while computers keep running
and are adopted on startup. `helm rollback` alone cannot undo application or bucket changes.

## Back up and restore

A recovery point needs the whole celld bucket, chart version, Helm values, platform and
S3 Secrets, and every computer PVC. The chart-managed Secrets are `<release>-secrets`
and `<release>-s3`; back up the supplied Secrets instead when `existingSecret` or
`s3.existingSecret` is set. The bucket contains platform records; it does not
contain the computer disks. Keep backups and snapshots outside the installation's lifecycle.

For a consistent backup, stop incoming traffic and scale celld and computerd to zero.
Replace `<namespace>` and `<release>` below with the installation's namespace and release name:

```sh
kubectl -n <namespace> scale statefulset/<release>-celld deployment/<release>-computerd --replicas=0
```

Set each running Sandbox's `spec.operatingMode` to `Suspended` and wait until no pods
labeled `baskule.computer=true` remain. Preserve the Sandboxes and PVCs. Copy the
complete bucket and take CSI snapshots of the stopped disks,
recording each PVC name, access modes, StorageClass, and storage request. Save the Secrets
with that recovery point. Restart computerd at one replica and celld at the saved replica
count; computers resume on next use.

Disk restore requires VolumeSnapshot CRDs, a snapshot-capable CSI driver, and its
VolumeSnapshotClass. Keep traffic stopped and prevent concurrent computer ensures:

1. Record the original Sandbox/PVC names and hashes of known files. With computerd
   running, stop the computer through [its API](../computerd/README.md#api) using
   `POST /v1/spaces/:id/computer/stop`.
2. Create a snapshot of the stopped PVC and wait for `status.readyToUse`.
3. After securing the snapshot, delete the computer with
   `POST /v1/spaces/:id/computer/delete` and `{"confirm":"<spaceId>"}`. This deletes its
   Sandbox and original disk. Wait until the PVC is absent.
4. Create a PVC with exactly the original name, access modes, StorageClass, and capacity.
   Add `agents.x-k8s.io/adoptable: "true"` and set `spec.dataSource` to the snapshot.
   Do not copy old controller references, UIDs, or resource versions.
5. Call `POST /v1/spaces/:id/computer/ensure`. Agent Sandbox adopts the restored PVC.
   Compare file hashes before allowing users back in or deleting backups.

Use bearer `COMPUTERD_TOKEN` for that API. The installation's operator can reach it with
`kubectl -n baskule port-forward svc/baskule-computerd 47094:47094`.
For a complete recovery, keep traffic stopped and restore the bucket and Secrets while
celld and computerd are stopped. Start computerd only, at one replica, restore the disks
through its API as above, then start celld at the saved replica count. Verify chat history
and file bytes before reopening traffic. Validate restore with your CSI driver. The kind
check proves PVC persistence, not snapshot restore or cross-cluster disaster recovery.

## Uninstall

Stop or delete computers before uninstalling, because uninstall removes their NetworkPolicies:

```sh
helm uninstall baskule --namespace baskule
```

Helm retains chart-managed Secrets and leaves the external bucket untouched. Sandboxes,
their pods, and PVCs remain unless explicitly deleted. Deleting a Sandbox removes its
owned PVCs; inspect the StorageClass reclaim policy for retained backing disks. For a
disposable installation, delete Sandboxes, uninstall, then remove remaining PVCs and Secrets.
Do not remove the cluster-wide Agent Sandbox controller if other installations use it.

## Verify a source change

Follow [Build server, web, and images](building.md#build-server-web-and-images) with
`deploy/build.sh --no-deploy`, then prepare the images for the local kind check:

```sh
source scripts/env.sh
scripts/docker-build.sh celld --network host --target release -t baskule-celld:kubernetes -f deploy/celld/Dockerfile .
for image in computerd computer; do
  docker tag "baskule-$image:local" "baskule-$image:kubernetes"
done
scripts/check kubernetes
```

`scripts/check release` runs the same check and needs the same images.
The local check requires Docker, kind, kubectl, Helm, Python 3, and jq. It creates a
disposable kind cluster with Calico, Agent Sandbox, and RustFS as a test-only S3 fixture
outside the chart. Checks cover
setup, conditional writes, fake streamed chat, computer execution, stop/start and pod
replacement with persistent file bytes, network isolation, CDP, celld takeover, space/PVC
deletion, and Helm upgrade token stability. It also checks the image-tag merge using two
packaged chart versions. That fixture does not prove cross-release schema migration.

The kind fixture uses 1 CPU and 1 GiB per computer. Its local PVCs stay on one node;
external block CSI rescheduling and public Ingress/Gateway behavior need separate validation.
The kind runner removes its cluster on exit and saves local diagnostics under
`.run/evidence/kind/`.

To check cross-node PVC persistence, use a disposable cluster with an enforcing CNI,
a block CSI StorageClass, and at least two eligible nodes that can attach the same volume.
The shared installer targets kubectl's current context and installs the cluster-wide
Agent Sandbox CRDs and controller. It does not create or delete the cluster. Check the
context before running it; never point it at an installation with data you need to keep.

Publish the three source images under the selected registry/tag so the nodes can pull them.
Create the S3 credential Secret in the test namespace and supply its endpoint, region,
bucket, and Secret name in `BASKULE_K8S_VALUES`, along with the computer StorageClass.
The namespace and release default to `baskule`; `BASKULE_K8S_NAMESPACE` and
`BASKULE_K8S_RELEASE` override them. Then run:

```sh
BASKULE_K8S_REGISTRY=registry.example.com/test BASKULE_K8S_TAG=source-check \
BASKULE_K8S_VALUES=/secure/path/kubernetes-test-values.yaml BASKULE_K8S_CROSS_NODE=1 \
BASKULE_K8S_JOURNEY=full bash e2e/kubernetes-install.sh
```

`full` is the default and expects a fresh installation with setup still required.
After a full pass with unchanged inputs, `failover` repeats chat, file, celld takeover,
and space/PVC deletion checks while skipping the full computer lifecycle/isolation checks.
`upgrade` skips the application journey and runs install and Helm upgrade checks only.
The `full` journey uses `BASKULE_K8S_CROSS_NODE=1` to cordon the computer's node and
verify that a replacement on another node mounts the same PVC and file bytes.

## Troubleshooting

- A failed conditional-write diagnosis means the S3 endpoint is unsuitable for leases.
  Check the endpoint and credentials, then consult [storage compatibility](storage-conformance.md).
- Pending computers usually need capacity, an attachable PVC, or an available image.
  Inspect `kubectl -n baskule describe pod <pod>` and `describe pvc <claim>` and controller events.
- Exec upgrade failures require `v5.channel.k8s.io` support throughout the API-server path.
  Verify that intervening proxies preserve WebSocket upgrades.
- DNS failures need the actual resolver allowed by the CNI. Verify DNS pod labels and
  `computers.dnsServerCidrs`; do not disable NetworkPolicy to bypass the failure.
- Buffered answers, early disconnects, or rejected uploads need matching streaming,
  WebSocket, body-size, and timeout settings on every proxy hop.
- Setup and sign-in origin failures require `publicUrl` to match the browser origin.
  Keep the Helm setup link and Secrets out of shared logs.

## Limits

The chart does not migrate a Compose installation. computerd high availability, TLS
automation, multi-zone storage failover, and model-provider configuration are separate
operational concerns. Validate your controller, CSI driver, RuntimeClass, and recovery
procedure on the target cluster before relying on them.

## Upgrade from 0.5.0

There is no migration or upgrade path from the multi-host Compose cluster shipped in
0.5.0 to the Helm chart. The installation's operator must stop writes and back up the
S3 bucket, computer host state and disks, and deployment secrets before retiring that
installation. Those backups cannot be restored into the chart. A new chart installation
starts with new accounts, settings, chats, and computers. Deleting the old bucket or
volumes destroys the platform records and computer files stored there.
