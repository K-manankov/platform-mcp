---
name: sonar-platform-observability
description: Organize project logging, metrics, dashboards and alerting on sonar-prod using Alloy/Loki, Prometheus and optional project-owned AlertmanagerConfig. Use when connecting project monitoring, instrumenting metrics, choosing log labels, creating PrometheusRule or routing Telegram alerts. For a deployment or pod failure unrelated to monitoring setup, use sonar-platform-debug.
---

# Monitoring projects on sonar-prod

## Platform contract

- Grafana: https://grafana.infra.sonar-corp.ru (VPN). Logs: stdout/stderr →
  Grafana Alloy DaemonSet → Loki. Metrics/alerts: Prometheus → Alertmanager →
  Telegram. Loki ruler is disabled; collecting logs does not create alerts.
- One namespace per project; test/prod share it. Deliver monitoring resources
  through the project's deploy repo and Argo CD, not manual kubectl apply.
  Keep environment suffixes and selectors consistent with the project's overlays.
- Logging collection already exists. Do not deploy another Loki, Alloy,
  Prometheus or Alertmanager just to connect a project.
- Monitoring resources and notification routing are optional. Without an
  AlertmanagerConfig, applications still deploy; project alerts remain visible
  in monitoring but do not send Telegram messages. There is currently no
  fallback “unassigned projects” channel.

Source of truth in infra/k8s/platform: platform/grafana-alloy/values.yaml,
platform/loki/values.yaml, platform/kube-prometheus-stack/values.yaml and
examples/project-alerting/. Check these when changing platform-wide behavior.
Retention is currently 7 days for Loki and Prometheus, not indefinite storage.

## Logs

Write application logs to stdout/stderr. Prefer one JSON object per line with
timestamp, level, service, environment, event and request/trace identifier.
Never log tokens, authorization headers, passwords or full sensitive payloads.
Request/user/trace identifiers belong in log content, not Loki stream labels.

Alloy currently supplies stream labels namespace, pod, container and node;
it does not automatically promote arbitrary application fields or pod labels.
Use Grafana Explore with datasource Loki, for example:

```logql
{namespace="sonar-compute", container="litellm"} |= "error"
{namespace="sonar-compute"} | json | level="error"
```

Choose actual container/JSON field names. For test/prod filtering, inspect
pod names or parsed environment fields: there is no automatic environment
stream label. No need for a file-writing sidecar for ordinary application logs.

Alloy discovery filters spec.nodeName using NODE_NAME from the downward API.
Preserve that filter: removing it makes every collector read the entire
cluster, duplicating logs. Remote-node collection needs the existing toleration.
The current source is loki.source.kubernetes (Kubernetes API log reading),
not a promise that arbitrary files in application containers are collected.

## Metrics and dashboards

Expose /metrics using a Prometheus client. Return a valid metrics Content-Type
(e.g. text/plain; version=0.0.4 for text exposition); a blank Content-Type can
cause Prometheus to reject an otherwise reachable endpoint. Fix the exporter
before considering a narrowly scoped fallback protocol.

Add a named metrics port to the Service and a ServiceMonitor in the project
namespace (PodMonitor if there is no Service). ServiceMonitor.selector selects
Service metadata labels, not Deployment labels; endpoints.port is the Service
port NAME, not its number. Keep namespace selection within the project.

Before choosing CR labels, inspect the deployed Prometheus selectors, or the
pinned kube-prometheus-stack chart when cluster access is unavailable. The
current Helm defaults select ServiceMonitor, PodMonitor and PrometheusRule by
release: kube-prometheus-stack across namespaces. A CR without the selected
label can sync successfully and still never be discovered. Do not widen
platform selectors just to fix one project's missing label.

Use bounded metric label sets (service, environment, method, route template,
status class). Do not use request_id, user_id, arbitrary URLs or error messages
as metric labels. Reuse standard Kubernetes metrics for pod/job/deployment
health rather than recreating those rules in each project.

For a project dashboard, start from request rate, error rate, latency, queue
backlog and dependency health relevant to that service. Use namespace and
environment filters where the actual series provide them. Do not assume a
shared namespace's environment can be inferred without checking the labels.

## Project alerts and notification channels

Read [references/project-alerting.md](references/project-alerting.md) when
adding rules or delivery; it includes copyable examples and naming constraints.

Use PrometheusRule for project-specific alert conditions. Add severity,
summary, an actionable description and a suitable for duration. Explicitly set
labels.namespace to the project namespace, even for aggregates that remove
namespace from the PromQL result: the CR's metadata.namespace alone does not
automatically label its alerts. A project label alone cannot route through
OnNamespace. Scope queries to the project; shared monitoring is not a tenant
security boundary for arbitrary PromQL or Grafana data access.

Project-owned AlertmanagerConfig requires label
sonar-corp.ru/alert-routing: enabled. Operator selects it across namespaces and
enforces OnNamespace on routes and inhibition rules. One unconditionally
matching config per project namespace is enough for both environments.
Multiple overlapping configs cause duplicate delivery because Operator forces
continue=true and prepends their routes to the platform routes.

The main channel accepts platform namespaces and cluster-wide alerts without
namespace/project. It must not contain a catch-all Telegram route after project
routes. Projects change channels in their own repo, without editing platform
manifests. Unknown namespaces default to the null receiver.

Existing example: sonar-compute/deploy/alerting is an optional component,
included only by overlays/test, delivering all sonar-compute namespace alerts
to group -1003026252392, topic 11943. The platform topic is 1476. These are
existing destinations, not defaults to copy into a new project.

## Verify the whole pipeline

1. Build Kustomize with and without optional monitoring; applications must not
   reference monitoring-only Secrets or require AlertmanagerConfig to start.
2. Check Prometheus target discovery, scrape errors and evaluated rule labels.
3. Confirm the CR was selected and Operator did not reject it; then inspect
   the LOADED Alertmanager configuration, not just the desired Secret or CR.
4. Test actual routes (amtool config routes test) for project, platform and a
   project without a config. Ensure no duplicate main-channel delivery.
5. Check receiver chat/topic, firing alert receivers, delivery error counters
   and logs. Aggregate Telegram success counters do not prove delivery to a
   specific topic. Explicitly distinguish verified routing from observed
   successful delivery or a message visible in Telegram.

MCP currently has no dedicated Loki/Prometheus/Alertmanager query tools.
argocd_exec supports app get/resources/logs (check argocd_auth_status first).
Use bounded log snapshots; --follow is blocked. With authorized cluster access,
kubectl reads or temporary port-forward/API queries can inspect monitoring.
Do not invent unavailable tools or assume every project user has cluster-admin.
Do not print raw Secret data, bot tokens or credential-bearing generated config;
extract only routes, receiver names and non-secret chat/topic fields.

For VPN/auth/cluster incidents, use sonar-platform-debug. For new bot tokens in
Vault/ExternalSecret, use sonar-platform-secrets; for rollout, use
sonar-platform-deploy. These skills provide procedures, not authorization to
send arbitrary messages or alter monitoring beyond the user's task.
