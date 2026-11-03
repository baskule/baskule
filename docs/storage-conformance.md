# S3 conditional-write conformance

celld 0.6.3's own `diagnose` command was run against disposable, tagged cloud
buckets on 2026-11-03. Credentials were not retained in evidence. Each bucket and
its contents were deleted afterwards and the provider inventory checked.

```sh
celld diagnose --json --bucket "s3://$BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

| S3 API | Region | Probe run | Result |
| --- | --- | --- | --- |
| Google Cloud Storage, `https://storage.googleapis.com` | `europe-west1` | `1793743423-54b8` | **Fail**: create-if-absent overwrote the existing object |
| Scaleway Object Storage, `https://s3.fr-par.scw.cloud` | `fr-par` | `1793744737-3f4d` | **Pass**: create, reject-create, update, reject-stale |

GCS accepted a conditional write without enforcing the absent-object condition.
celld reported that accepting `If-Match` / `If-None-Match` this way could allow two
nodes to own one cell, and rejected the store. This evaluates its S3 XML API, not
celld's separate native `gs://` backend. The chart uses S3 and does not support GCS.
The temporary GCS HMAC key and service account were also deleted; the cleanup audit
found zero buckets, HMAC keys, service accounts or project IAM references for the run.

Scaleway passed all four operations. Its final inventory contained zero ephemeral
buckets; no IAM applications or API keys were created for this probe.
AWS S3 and Cloudflare R2 were not tested in this change. Garage v2.5.0 had already
failed celld's conditional-write check in the initial Kubernetes evaluation.

Raw local records remain under ignored `.run/evidence/gcs-probe-1793743423-54b8/`
and `.run/evidence/scw-probe-1793744737-3f4d/`. They contain diagnostic results and
cleanup counts, not credentials. No GKE nodes were created for these probes.
