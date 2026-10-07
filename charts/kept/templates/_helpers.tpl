{{/* Names and labels. */}}
{{- define "kept.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "kept.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels for one component: server, web, worker, postgres. */}}
{{- define "kept.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The component that runs the jobs (and the backups, D186), and holds the owner login. */}}
{{- define "kept.jobsComponent" -}}
{{- if .Values.split.enabled }}worker{{ else }}server{{ end -}}
{{- end -}}

{{/* The component that serves HTTP. */}}
{{- define "kept.webComponent" -}}
{{- if .Values.split.enabled }}web{{ else }}server{{ end -}}
{{- end -}}

{{/* The image, never untagged or `latest`. */}}
{{- define "kept.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion | toString -}}
{{- if or (eq $tag "") (eq $tag "latest") -}}
{{- fail "image.tag: set a release version; Kept has no `latest` tag" -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .Values.image.digest) -}}
{{- fail "image.digest: expected sha256:<64 hex digits>" -}}
{{- end -}}
{{- printf "%s:%s@%s" .Values.image.repository $tag .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/* Refusals that the schema can't express. Included once, by the server or web Deployment. */}}
{{- define "kept.validate" -}}
{{- if not .Values.publicUrl -}}
{{- fail "publicUrl is required: the address people open Kept at, e.g. https://kept.example.org" -}}
{{- end -}}
{{- if not .Values.roles.existingSecret -}}
{{- fail "roles.existingSecret is required: a secret holding KEPT_DB_OWNER_PASSWORD, KEPT_DB_APP_PASSWORD, KEPT_DB_AUTH_PASSWORD and KEPT_DB_SYSTEM_PASSWORD (README.md)" -}}
{{- end -}}
{{- if and .Values.postgres.bundled (not .Values.postgres.superuserSecret) -}}
{{- fail "postgres.superuserSecret is required with the bundled Postgres: a secret holding POSTGRES_PASSWORD" -}}
{{- end -}}
{{- if not .Values.postgres.bundled -}}
{{- if not .Values.postgres.external.host -}}
{{- fail "postgres.external.host is required when postgres.bundled is false" -}}
{{- end -}}
{{- if and .Values.roles.create (not .Values.postgres.superuserSecret) -}}
{{- fail "roles.create needs postgres.superuserSecret (the server admin's POSTGRES_PASSWORD); or set roles.create=false and run the managed-Postgres SQL yourself" -}}
{{- end -}}
{{- end -}}
{{- if .Values.split.enabled -}}
{{- if not .Values.keys.existingSecret -}}
{{- fail "split.enabled needs keys.existingSecret: two Deployments can't share keys generated into one ReadWriteOnce config volume" -}}
{{- end -}}
{{- if and (eq .Values.storage.mode "local") (ne .Values.storage.persistence.accessMode "ReadWriteMany") -}}
{{- fail "split.enabled with local files needs storage.persistence.accessMode=ReadWriteMany (web and worker both read the files), or storage.mode=s3" -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.storage.mode "s3") (not .Values.storage.s3.bucket) -}}
{{- fail "storage.mode=s3 needs storage.s3.bucket" -}}
{{- end -}}
{{- end -}}

{{/* Database coordinates. */}}
{{- define "kept.dbHost" -}}
{{- if .Values.postgres.bundled -}}{{ include "kept.fullname" . }}-postgres{{- else -}}{{ .Values.postgres.external.host }}{{- end -}}
{{- end -}}
{{- define "kept.dbPort" -}}
{{- if .Values.postgres.bundled -}}5432{{- else -}}{{ .Values.postgres.external.port }}{{- end -}}
{{- end -}}
{{- define "kept.dbQuery" -}}
{{- if and (not .Values.postgres.bundled) .Values.postgres.external.sslMode -}}?sslmode={{ .Values.postgres.external.sslMode }}{{- end -}}
{{- end -}}

{{/*
One login's URL: the password from the roles secret, then the URL built from it with Kubernetes'
$(VAR) expansion, so the password never appears in the rendered manifest.
Arguments: root, login (owner, app, auth, system), var (the URL's variable name).
*/}}
{{- define "kept.dbUrlEnv" -}}
{{- $root := .root -}}
{{- $upper := upper .login -}}
- name: KEPT_DB_{{ $upper }}_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.roles.existingSecret }}
      key: KEPT_DB_{{ $upper }}_PASSWORD
- name: {{ .var }}
  value: {{ printf "postgres://kept_%s:$(KEPT_DB_%s_PASSWORD)@%s:%s/%s%s" .login $upper (include "kept.dbHost" $root) (include "kept.dbPort" $root) $root.Values.postgres.database (include "kept.dbQuery" $root) | quote }}
{{- end -}}

{{/* The variables every Kept container shares, the Jobs included. */}}
{{- define "kept.commonEnv" -}}
- name: KEPT_PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: KEPT_STORAGE
  value: {{ .Values.storage.mode | quote }}
{{- if eq .Values.storage.mode "s3" }}
{{- with .Values.storage.s3 }}
{{- if .endpoint }}
- name: KEPT_S3_ENDPOINT
  value: {{ .endpoint | quote }}
{{- end }}
{{- if .publicEndpoint }}
- name: KEPT_S3_PUBLIC_ENDPOINT
  value: {{ .publicEndpoint | quote }}
{{- end }}
{{- if .region }}
- name: KEPT_S3_REGION
  value: {{ .region | quote }}
{{- end }}
- name: KEPT_S3_BUCKET
  value: {{ .bucket | quote }}
- name: KEPT_S3_FORCE_PATH_STYLE
  value: {{ .forcePathStyle | toString | quote }}
{{- end }}
{{- end }}
{{- if .Values.smtp.from }}
- name: KEPT_SMTP_FROM
  value: {{ .Values.smtp.from | quote }}
{{- end }}
{{- if .Values.trustedProxies }}
- name: KEPT_TRUSTED_PROXIES
  value: {{ .Values.trustedProxies | quote }}
{{- end }}
{{- if .Values.backup.persistence.enabled }}
- name: KEPT_BACKUP_DIR
  value: /backups
{{- end }}
{{- range $name, $value := .Values.backup.env }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Secrets passed as variables under their own names. */}}
{{- define "kept.envFrom" -}}
{{- if .Values.keys.existingSecret }}
- secretRef:
    name: {{ .Values.keys.existingSecret }}
{{- end }}
{{- if and (eq .Values.storage.mode "s3") .Values.storage.s3.existingSecret }}
- secretRef:
    name: {{ .Values.storage.s3.existingSecret }}
{{- end }}
{{- if .Values.backup.existingSecret }}
- secretRef:
    name: {{ .Values.backup.existingSecret }}
{{- end }}
{{- if .Values.smtp.existingSecret }}
- secretRef:
    name: {{ .Values.smtp.existingSecret }}
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Kept's hardening (D186): uid 10001, read-only root, no capabilities. */}}
{{- define "kept.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
fsGroupChangePolicy: OnRootMismatch
seccompProfile:
  type: RuntimeDefault
{{- end -}}
{{- define "kept.securityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{/* Waits for the database to accept connections (pg_isready is in the image), so a first
install doesn't crash-loop while the bundled Postgres starts. Needs no credentials. */}}
{{- define "kept.waitForDb" -}}
- name: wait-for-db
  image: {{ include "kept.image" . }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command:
    - sh
    - -c
    - until pg_isready -q -h "$DB_HOST" -p "$DB_PORT" -t 5; do echo "waiting for $DB_HOST:$DB_PORT"; sleep 2; done
  env:
    - name: DB_HOST
      value: {{ include "kept.dbHost" . | quote }}
    - name: DB_PORT
      value: {{ include "kept.dbPort" . | quote }}
  securityContext:
    {{- include "kept.securityContext" . | nindent 4 }}
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      memory: 64Mi
{{- end -}}

{{/* Whether the config volume is a PVC (generated keys) or scratch (keys from a secret). */}}
{{- define "kept.configIsPvc" -}}
{{- if not .Values.keys.existingSecret }}true{{ end -}}
{{- end -}}

{{/* The backup volume's claim. */}}
{{- define "kept.backupClaim" -}}
{{- .Values.backup.persistence.existingClaim | default (printf "%s-backups" (include "kept.fullname" .)) -}}
{{- end -}}
