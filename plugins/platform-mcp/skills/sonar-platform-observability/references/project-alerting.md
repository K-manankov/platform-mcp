# Project resources

Examples use namespace demo, supplied by Argo CD destination. Replace it and
the Service labels with the actual project. Retain release labels only after
checking the deployed selectors. Put optional files in a Kustomize component
or explicitly opt-in resources, not in a mandatory application dependency.

## Scraping and rules

The application Service must have metadata.labels.app=myapp and a named
metrics port (for example name: metrics, port: 9090, targetPort: metrics).
The Deployment's container port must agree with targetPort.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myapp
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: myapp
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: myapp
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: demo.myapp
      rules:
        - alert: DemoMyappMetricsUnavailable
          expr: up{namespace="demo",service="myapp-test"} == 0
          for: 5m
          labels:
            namespace: demo
            severity: warning
          annotations:
            summary: Myapp metrics endpoint is unavailable
            description: Check the Service endpoints, exporter and scrape error.
```

Use the actual rendered Service name in the expression. `up == 0` covers an
existing target whose scrape fails, not a target absent from discovery. Choose
absent/absent_over_time rules separately when missing expected targets matter.
Do not duplicate an existing TargetDown alert without a reason.

## Delivery with the existing shared bot

Only use the shared bot when the user chooses it and the destination is known.
Obtain chat_id and, for a forum topic, message_thread_id; do not invent them.
The platform already mounts the bot token at the file below. A project using
that bot needs no additional Secret. Replace the example chatID before enabling.

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: project-alerts
  labels:
    sonar-corp.ru/alert-routing: enabled
spec:
  route:
    receiver: telegram
    groupBy: [namespace, alertname]
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 4h
    routes:
      - receiver: telegram
        matchers:
          - name: alertname
            value: KubeJobFailed
            matchType: '='
        groupBy: [namespace, alertname, job_name]
        repeatInterval: 8760h
  receivers:
    - name: telegram
      telegramConfigs:
        - botTokenFile: /etc/alertmanager/secrets/alertmanager-telegram/bot-token
          chatID: -1000000000000 # Replace; not a real destination.
          # messageThreadID: 123
          sendResolved: true
          parseMode: HTML
          message: |-
            {{ range .Alerts -}}
            {{ .Status | html }}: {{ .Labels.alertname | html }} ({{ .Labels.namespace | html }})
            {{ .Annotations.summary | html }}
            {{ .Annotations.description | html }}
            {{ end }}
          httpConfig:
            proxyURL: http://mihomo.infra.sonar-corp.ru:7890
```

CRD parseMode permits HTML/Markdown/MarkdownV2, not an empty string. Escape
dynamic content as above rather than inserting unescaped annotations into
markup. Telegram requests use mihomo because direct access can be unreliable.

## Separate bot and optional configuration

For a project's own bot, replace botTokenFile with botToken:
`{name: project-alerts-telegram-test, key: bot-token}`. Create that Secret in the
same namespace via ExternalSecret backed by kv/projects/<project>/alerting/telegram.
Use the project's existing namespaced SecretStore and allowed Vault ServiceAccount.
Never commit the token or copy the platform's secret value into the repository.

With nameSuffix: -test, reconcile botToken.name, ExternalSecret.spec.target.name
and secretStoreRef.name explicitly: Kustomize does not automatically rewrite
these CRD references. Do not wire a project-wide config into both test and prod.
Missing optional config is supported; a configured but missing Secret is an
alert-delivery error to diagnose, not the same as opting out. Application startup
must not depend on this monitoring-only Secret.

## Notification noise

KubeJobFailed groups by job_name to avoid resending every retained failed Job
when a new one fails. A year repeat interval is not durable event deduplication:
Alertmanager currently retains its notification log for 120h, so reminders can
recur after retention expires or state is lost. Each new failed CronJob run is
still a new alert. Resolved can mean the old Job was removed, not that a new run
succeeded. Diagnose failures and set appropriate Job history/TTL policies instead
of hiding real production failures by default.

Default inhibition only suppresses lower severity for the same namespace and
alertname; it does not deduplicate different alert names about one root cause.
Custom project inhibition should suppress consequences only when the relationship
is clear and retain visibility of the primary fault.
