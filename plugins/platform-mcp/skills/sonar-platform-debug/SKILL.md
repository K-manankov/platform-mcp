---
name: sonar-platform-debug
description: How to debug and troubleshoot problems on the sonar-prod Kubernetes platform — Argo CD apps stuck OutOfSync/Degraded/Missing, pods crashlooping or Pending, secrets not showing up in pods, outbound internet/HTTP requests failing from pods, or the platform-mcp Argo CD/Vault tools erroring or timing out. Use whenever the user reports something broken or unexpected on sonar-prod: "my app isn't syncing", "pod won't start", "deploy is stuck", "can't reach argocd.infra.sonar-corp.ru", "vault_exec keeps failing", "pod can't reach the internet", "how do I set up a proxy for my app", or similar. Covers the platform-specific gotchas (VPN/DNS, node naming, local storage, outbound proxy) that generic Kubernetes debugging knowledge won't catch.
---

# Debugging on sonar-prod

Before diving into app-specific diagnosis, rule out the platform-level gotchas below — they cause
a disproportionate share of "nothing works" reports and don't look like what they are.

## Step 0: connectivity and auth

- **VPN.** `argocd.infra.sonar-corp.ru` and `vault.infra.sonar-corp.ru` only resolve to the real
  cluster (`192.168.88.106`) from inside the VPN. Outside it, a public wildcard
  `*.infra.sonar-corp.ru` answers instead, and the request just goes nowhere — no clean
  connection-refused, just confusing timeouts or TLS errors. Check with
  `dig +short argocd.infra.sonar-corp.ru`; if it's not `192.168.88.106`, that's the whole problem,
  fix VPN first before debugging anything else. The self-signed cert on these hosts is expected
  (one browser warning), not itself a bug.
- **Auth.** Run `argocd_auth_status` / `vault_auth_status` before anything else. An
  expired/missing session produces tool errors that look unrelated to auth if you don't check
  this first. Re-auth with `argocd_login` / `vault_login`.

## Diagnosing a stuck or unhealthy Argo CD app

App names carry the environment: `<project>-<repo>-test` / `<project>-<repo>-prod`. There is no
Application without the suffix, so a command using the bare `<project>-<repo>` matches nothing.
The namespace, by contrast, is just `<project>` — shared by both environments and every service.

```
argocd_exec { "args": ["app", "get", "<project>-<repo>-<env>"] }
    # sync status (Synced/OutOfSync), health (Healthy/Degraded/Progressing/Missing),
    # per-resource state, recent sync history — start here

argocd_exec { "args": ["app", "logs", "<project>-<repo>-<env>"] }
    # container logs snapshot. --follow is blocked by the plugin (it never terminates) —
    # fetch a snapshot, re-run if you need fresher output rather than trying to stream

argocd_exec { "args": ["app", "resources", "<project>-<repo>-<env>"] }
    # per-resource sync/health breakdown, useful to isolate which specific object is unhappy

argocd_exec { "args": ["app", "list", "-l", "sonar-corp.ru/environment=prod"] }
    # environment lives on the Application's labels, never on the namespace
```

Common platform-specific causes, roughly in order of how often they bite:

- **App not appearing at all yet.** The `k8s-projects` scan runs every ~3 minutes; a brand-new
  repo or a newly-added `deploy/overlays/` directory needs to wait for that cycle. See the
  onboarding skill if this is a first-time setup, not an existing app.
- **`ComparisonError` on one environment only.** The overlay directory for that environment
  doesn't exist. Environments are enumerated platform-side, so a repo with only
  `overlays/test` still gets a `-prod` Application, and it fails loudly rather than being skipped.
- **Two environments fighting over the same object** — resources flipping between Synced and
  OutOfSync, or fields reverting seconds after a sync. The overlay is missing `nameSuffix: -<env>`,
  so both Applications claim the same object and, with `prune` + `selfHeal` on both, overwrite each
  other indefinitely. Same root cause if a Service in test is routing to prod pods: that's the
  environment label missing `includeSelectors: true`.
- **`could not find kustomize.config.k8s.io/Kustomization ... make sure the CRD is installed`.**
  Nothing to install — this means `source.directory` got set somewhere, forcing the Directory
  source type so `kustomization.yaml` is applied as a literal manifest instead of being built.
- **Node selector using the short hostname.** Node names in this cluster are full FQDNs
  (`k8s-worker-01.infra.sonar-corp.ru`), because that's how they joined the cluster, and
  `kubernetes.io/hostname` holds the FQDN. A `nodeSelector` with the short name
  (`k8s-worker-01`) matches nothing and the pod sits in `Pending` silently.
- **PersistentVolume pinned to a dead/wrong node.** Default StorageClass is `local-path` — the
  volume is a directory on whichever node the pod first landed on. A pod that needs its existing
  volume can't reschedule to a different node, and `reclaimPolicy: Retain` means a deleted PVC
  doesn't free the data either — freeing it is a manual step.
- **Missing/misplaced `deploy/overlays/` directory** (the marker is `overlays/`, not a flat
  `deploy/`), or manifests that hard-code a namespace — the namespace is always `<project>`,
  supplied by the Application, and shouldn't be set in the manifests at all.

## Vault-side debugging

```
vault_auth_status
    # shows the logged-in identity's `policies` — the fastest way to see whether this user/role
    # even has access to kv/projects/<project>/* before debugging anything downstream

vault_exec { "args": ["kv", "list", "kv/projects/<project>"] }
    # what secrets exist under the project. Exit code 2 here usually means "empty path or no
    # list ACL" — it does NOT mean "wrong mount", don't go hunting for alternate mount paths

vault_exec { "args": ["kv", "get", "kv/projects/<project>/<app>/<env>"] }
    # read one secret's metadata + keys (values are redacted from the tool response by design —
    # see below, this is not a bug or something to work around). Note the trailing environment
    # segment: kv/projects/demo/myapp is the parent, not the secret
```

Avoid `sys/mounts` for discovery — normal OIDC users usually get a 403 on it, which looks like a
broken setup but is just a permissions boundary that doesn't apply to `kv/`.

## If an `ExternalSecret` isn't producing a k8s `Secret`

These objects live in `deploy/overlays/<env>/`, not `base/`. Check, in that overlay:

- The `SecretStore`'s `spec.provider.vault.auth.kubernetes.role` matches the project name exactly
  (the role is per-project — the environment does not appear in it).
- The `ExternalSecret`'s `dataFrom.extract.key` matches `projects/<project>/<app>/<env>` exactly,
  environment segment included (no `kv/` prefix inside this field — that's implied by the
  `SecretStore`'s `path: kv`).
- The `ServiceAccount` resolves to one of `vault`, `vault-test`, `vault-prod` — those three names
  are listed literally in the project's Vault Kubernetes-auth role, because
  `bound_service_account_names` doesn't do prefix globs. Any other name authenticates as nobody.
- **The cross-references carry the environment suffix by hand.** `nameSuffix` renames objects but
  cannot rewrite references inside CRDs, so `SecretStore.serviceAccountRef.name`,
  `ExternalSecret.secretStoreRef.name` and `ExternalSecret.target.name` must each spell out
  `-test`/`-prod` themselves. This is the most common failure in this section. A missed suffix on
  `target.name` is the sneakiest: it doesn't error, it just makes both environments generate one
  shared `Secret` and overwrite it in turn.
- The namespace actually has the `vault.sonar-corp.ru/project` label — this gets applied
  automatically on first sync, so an app that's never synced successfully won't have it yet,
  which blocks Vault auth in a way that looks unrelated to sync status.

## Outbound internet works directly; mihomo is only for blocked resources

Pods on sonar-prod reach the internet **directly** — there is a normal egress path out of the
cluster and no proxy env vars are needed for ordinary outbound calls. The `mihomo` proxy exists
for one narrower case: resources unreachable from Russia (blocked here, or geo-restricted against
Russian exit addresses). It's a fault-tolerant proxy client with two VPN subscriptions and
automatic failover between them (`url-test` picks the lowest-latency node within a subscription,
`fallback` switches subscription entirely if every node in the primary one stops responding).

So when a pod reports "can't reach the internet", don't assume a missing `HTTP_PROXY` — first
check whether the destination is actually blocked. If it isn't, the failure is DNS, NetworkPolicy,
the remote endpoint, or the app itself, and adding proxy env vars will only move the problem.

- **In-cluster apps needing a blocked resource**: point `HTTP_PROXY`/`ALL_PROXY` at
  `http://mihomo.infra.sonar-corp.ru:7890` (mixed port, serves both SOCKS5 and HTTP) — use the
  external DNS name, not `mihomo.mihomo.svc.cluster.local`, so the same address works both from
  pods and from a VPN-connected console. Always set `NO_PROXY`/`no_proxy` to include
  `.svc.cluster.local,.cluster.local,10.0.0.0/8,192.168.88.0/24` — otherwise in-cluster and
  VPN-internal traffic gets routed through the proxy too, which usually just times out. See the
  Alertmanager config in `platform/kube-prometheus-stack/values.yaml` in the `infra` repo for a
  worked example.
- **From the console (VPN)**: the same port is reachable directly, no in-cluster hop needed —
  `curl -x http://mihomo.infra.sonar-corp.ru:7890 https://ifconfig.me`. Like everything else on
  `*.infra.sonar-corp.ru`, this only works over VPN (see Step 0 above) — outside it you get the
  same silent-timeout failure mode as argocd/vault.
- **Dashboard**: `https://mihomo.infra.sonar-corp.ru` (metacubexd) shows which node/subscription is
  currently active and lets you manually pin a different one — useful when diagnosing "outbound
  requests are slow/failing" reports, since a bad upstream VPN node looks identical to an app bug
  from inside the pod. No login (VPN is the only access boundary, by design).
- **Quick health check**: `kubectl -n mihomo exec deploy/mihomo -c mihomo -- curl -sf
  http://127.0.0.1:9090/version`. If a pod can't reach a *blocked* resource but this succeeds, the
  problem is almost always a missing/wrong `HTTP_PROXY`/`ALL_PROXY` env var on the app itself, not
  mihomo. For a resource that isn't blocked, mihomo is irrelevant to the diagnosis either way.

## Secret values are redacted on purpose

`vault_exec`/`argocd_exec` output has secret values stripped by default — `kv get` shows keys and
metadata but not values, and `Secret` resources from `argocd_exec` have `data`/`stringData`
scrubbed too, including when embedded inside JSON-stringified manifests. This is intentional
platform-mcp behavior, not a bug to route around: attempts like `-field=` or `-format=table` on
Vault commands are explicitly rejected by the plugin because they'd bypass redaction. If secret
values are genuinely needed in the conversation, that requires the user to opt in at the MCP
server level (`PLATFORM_MCP_ALLOW_SECRET_VALUES=true`) — it's not something achievable per call,
and shouldn't be suggested as a quick workaround for a single debugging session.
