# S3 conditional-write compatibility

Baskule requires an S3-compatible bucket that atomically enforces `If-Match` and
`If-None-Match` writes. [celld](https://github.com/denoland/celld), the underlying runtime,
uses these operations for cell leases. Accepting a conditional write without enforcing
its condition can let two nodes hold the same cell. Upload/download tests are insufficient.

Run `celld diagnose` with the installation's configured bucket and credentials.

For Compose, run from the installation directory:

```sh
docker compose exec baskule-celld-a sh -ec 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"'
```

For Kubernetes, replace the namespace and pod name if needed:

```sh
kubectl -n baskule exec baskule-celld-0 -- sh -ec 'celld diagnose --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"'
```

The `bucket conditional write` check must report `ok` before using the bucket.

GCS's S3 XML API and Garage do not enforce the conditional-write semantics celld needs.
This does not evaluate celld's separate native GCS backend; Baskule uses S3.
