{{/* vim: set filetype=mustache: */}}
{{- define "tickerglass.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tickerglass.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tickerglass.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tickerglass.labels" -}}
helm.sh/chart: {{ include "tickerglass.chart" . }}
app.kubernetes.io/name: {{ include "tickerglass.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels: call with (dict "ctx" . "component" "api"). */}}
{{- define "tickerglass.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tickerglass.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "tickerglass.image" -}}
{{- printf "%s:%s" .repository (default .ctx.Chart.AppVersion .ctx.Values.image.tag) -}}
{{- end -}}

{{- define "tickerglass.secretName" -}}
{{- default (include "tickerglass.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{/* Secret holding METRICS_TOKEN: the user's own, or the chart's <fullname>-metrics. */}}
{{- define "tickerglass.metricsSecretName" -}}
{{- default (printf "%s-metrics" (include "tickerglass.fullname" .)) .Values.metrics.existingSecret -}}
{{- end -}}

{{/*
Renders `env:` list items from a map (strings, numbers, booleans or `valueFrom` objects).
Call with (dict "env" <map>).
*/}}
{{- define "tickerglass.envList" -}}
{{- range $name, $value := .env }}
- name: {{ $name }}
  {{- if kindIs "map" $value }}
  valueFrom:
    {{- toYaml $value | nindent 4 }}
  {{- else }}
  value: {{ $value | toString | quote }}
  {{- end }}
{{- end }}
{{- end -}}

{{/*
Secret-backed variable: call with (dict "name" "ALERTS_INTERNAL_TOKEN" "ctx" .). Add "optional" true
for a key an existingSecret may lack (AUTH_SECRET: the API then generates its own).
*/}}
{{- define "tickerglass.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "tickerglass.secretName" .ctx }}
      key: {{ .name }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}
