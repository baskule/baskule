{{- define "baskule.image" -}}
{{ printf "%s/baskule-%s:%s" .root.Values.global.image.registry .name (.root.Values.global.image.tag | default .root.Chart.AppVersion) }}
{{- end -}}
{{- define "baskule.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: baskule
{{- end -}}
{{- define "baskule.secretName" -}}
{{ .Values.existingSecret | default (printf "%s-secrets" .Release.Name) }}
{{- end -}}
{{- define "baskule.s3SecretName" -}}
{{ .Values.s3.existingSecret | default (printf "%s-s3" .Release.Name) }}
{{- end -}}
{{- define "baskule.secretData" -}}
{{- if not (hasKey .Values "_secretData") -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "baskule.secretName" .) -}}
{{- $data := dict -}}
{{- range $key := list "COMPUTERD_TOKEN" "SETUP_TOKEN" -}}
{{- if $existing -}}
{{- $_ := set $data $key (required (printf "existing Secret missing %s" $key) (index $existing.data $key)) -}}
{{- else -}}
{{- $_ := set $data $key (randAlphaNum 64 | b64enc) -}}
{{- end -}}
{{- end -}}
{{- $_ := set .Values "_secretData" $data -}}
{{- end -}}
{{ toYaml .Values._secretData }}
{{- end -}}
{{- define "baskule.s3Endpoint" -}}
{{ required "s3.endpoint is required; supply an S3 bucket with conditional writes" .Values.s3.endpoint }}
{{- end -}}
{{- define "baskule.s3Env" -}}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef: {name: {{ include "baskule.s3SecretName" . }}, key: AWS_ACCESS_KEY_ID}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef: {name: {{ include "baskule.s3SecretName" . }}, key: AWS_SECRET_ACCESS_KEY}
- {name: AWS_REGION, value: {{ .Values.s3.region | quote }}}
- {name: S3_ENDPOINT, value: {{ include "baskule.s3Endpoint" . | quote }}}
- {name: CELLD_BUCKET_NAME, value: {{ (required "s3.bucket is required" .Values.s3.bucket) | quote }}}
- {name: CELLD_BUCKET, value: {{ printf "s3://%s" (required "s3.bucket is required" .Values.s3.bucket) | quote }}}
{{- end -}}
