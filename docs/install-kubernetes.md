# Install on Kubernetes

The [Helm chart](../deploy/helm/baskule/Chart.yaml) runs celld as a StatefulSet and
computerd with the Kubernetes backend. Use [Compose](install.md) for one machine.
Provide a NetworkPolicy-enforcing CNI, a CSI StorageClass, and S3-compatible storage
supporting celld's conditional writes. Computer disks are PVCs; platform state lives
in the S3 bucket. Keep both in backups.

Install the pinned agent-sandbox controller once per cluster:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox.yaml
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
```

Prepare a private values file from [values.yaml](../deploy/helm/baskule/values.yaml).
Set `publicUrl` to the public HTTPS origin. Configure `s3.endpoint`, `s3.region`,
`s3.bucket` and `s3.existingSecret`; the Secret contains `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. `existingSecret` contains `COMPUTERD_TOKEN`, `SETUP_TOKEN`
and `PLUGIN_SYNC_TOKEN`. GitOps/client rendering must supply both existing Secrets.
For evaluation only, `rustfs.enabled: true` provides local, nonredundant object storage.

Install the chart with Helm, supplying your values file and a released image tag
through `global.image.tag`. The source chart's placeholder tag is not a release.
`exposure.mode` selects `none` (port-forward), `ingress`, or `gateway`; the corresponding
controller is installed separately. See the chart values for exposure settings.
For example, after writing `values.private.yaml` with the settings above and a released
`global.image.tag`, run from the repository root:

```sh
helm upgrade --install baskule deploy/helm/baskule --namespace baskule --create-namespace -f values.private.yaml
```

Keep the release name and namespace stable: they determine resource identity.

## Computers

computerd has a dedicated ServiceAccount and least-privilege Role. It creates
agent-sandbox `Sandbox` objects and uses the Kubernetes API for exec and port-forward.
Pods run non-root, drop all capabilities, use RuntimeDefault seccomp, omit service
account tokens and run tini as PID 1. Their persistent disk mounts at `/sandbox/space`.

With `networkPolicy.enabled`, computer pods have no ingress and can send DNS to
kube-dns and traffic to `0.0.0.0/0` except private, link-local, CGNAT and reserved
ranges plus `computers.blockedCidrs`. Include any publicly addressed cluster, service,
node or organization networks in that list. Optional IPv6 follows `computers.ipv6`.
Clusters with a node-local DNS cache (for example GKE) answer DNS from an address
that is not a kube-dns pod: set `computers.dnsServerCidrs` to the resolver addresses
in a computer's `/etc/resolv.conf`, as `/32` CIDRs. This allows only port 53 there.
The CNI must enforce these policies. Plugin MCP servers are reached from celld,
not computers, and therefore are outside this computer policy.

All computer settings below are under `computers:` and checked by
[values.schema.json](../deploy/helm/baskule/values.schema.json).

| Key | Default | Purpose |
| --- | --- | --- |
| `image` | empty | Override the computer image; otherwise use release image |
| `cpus` | `"2"` | CPU request and limit |
| `memory` | `3Gi` | Memory request and limit |
| `diskSize` | `10Gi` | New PVC capacity |
| `storageClass` | empty | Cluster default StorageClass |
| `runtimeClassName` | empty | Optional installed RuntimeClass |
| `nodeSelector` | `{}` | Computer node labels |
| `tolerations` | `[]` | Computer scheduling tolerations |
| `imagePullSecrets` | `[]` | Computer registry Secrets, objects with `name` |
| `prePull.enabled` | `true` | DaemonSet pre-pulls the computer image |
| `blockedCidrs` | `[]` | Additional destinations blocked by NetworkPolicy |
| `ipv6` | `false` | Enable public IPv6 egress with exclusions |

Computers on Docker start in about a second on a warm host; on Kubernetes cold start
is dominated by image pull, which the pre-pull DaemonSet removes.

## Backup and snapshot restore

Back up the complete S3 bucket, Helm values and version, Secrets, and computer PVCs.
Quiesce writers before taking a consistent backup. Keep snapshots outside the lifecycle
of a disposable installation. Restoring the bucket alone does not restore computer files.

The GKE snapshot procedure is asserted in `e2e/kubernetes-journey.mjs` on branch
`computers/gke2`: it compares file hashes after restore using the GKE PD CSI driver.
This is GKE-only verification; other CSI drivers need their own restore check.

For a disk restore, preserve the space identity and use the following procedure:

1. Record the Sandbox and its PVC name `<disk>-<sandbox>`, plus the PVC's
   `accessModes`, `storageClassName` and `resources`. Record hashes of known files.
2. Stop the computer through computerd and prevent concurrent ensures. Create a
   `snapshot.storage.k8s.io/v1` VolumeSnapshotClass for your CSI driver (the GKE
   journey uses `pd.csi.storage.gke.io`) and a VolumeSnapshot whose
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
5. Only then call `POST /v1/spaces/:id/computer/ensure`. agent-sandbox adopts the
   restored PVC. Verify file hashes before allowing users back in or deleting backups.

## Local verification

After [build setup](building.md), `scripts/check kubernetes` exercises the disposable
kind installation with the fake LLM. This does not prove behavior on every production
CNI or CSI driver. Upgrades and recovery should retain the release's values, Secrets,
resource identities and storage configuration.
