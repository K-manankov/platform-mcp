---
name: sonar-platform-debug
description: How to debug and troubleshoot problems on the sonar-prod Kubernetes platform — Argo CD apps stuck OutOfSync/Degraded/Missing, pods crashlooping or Pending, secrets not showing up in pods, or the platform-mcp Argo CD/Vault tools erroring or timing out. Use whenever the user reports something broken or unexpected on sonar-prod: "my app isn't syncing", "pod won't start", "deploy is stuck", "can't reach argocd.infra.sonar-corp.ru", "vault_exec keeps failing", or similar. Covers the platform-specific gotchas (VPN/DNS, node naming, local storage) that generic Kubernetes debugging knowledge won't catch.
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

```
argocd_exec { "args": ["app", "get", "<project>-<repo>"] }
    # sync status (Synced/OutOfSync), health (Healthy/Degraded/Progressing/Missing),
    # per-resource state, recent sync history — start here

argocd_exec { "args": ["app", "logs", "<project>-<repo>"] }
    # container logs snapshot. --follow is blocked by the plugin (it never terminates) —
    # fetch a snapshot, re-run if you need fresher output rather than trying to stream

argocd_exec { "args": ["app", "resources", "<project>-<repo>"] }
    # per-resource sync/health breakdown, useful to isolate which specific object is unhappy
```

Common platform-specific causes, roughly in order of how often they bite:

- **App not appearing at all yet.** The `k8s-projects` scan runs every ~3 minutes; a brand-new
  repo or a newly-added `deploy/` directory needs to wait for that cycle. See the onboarding skill
  if this is a first-time setup, not an existing app.
- **Node selector using the short hostname.** Node names in this cluster are full FQDNs
  (`k8s-worker-01.infra.sonar-corp.ru`), because that's how they joined the cluster, and
  `kubernetes.io/hostname` holds the FQDN. A `nodeSelector` with the short name
  (`k8s-worker-01`) matches nothing and the pod sits in `Pending` silently.
- **PersistentVolume pinned to a dead/wrong node.** Default StorageClass is `local-path` — the
  volume is a directory on whichever node the pod first landed on. A pod that needs its existing
  volume can't reschedule to a different node, and `reclaimPolicy: Retain` means a deleted PVC
  doesn't free the data either — freeing it is a manual step.
- **Missing/misplaced `deploy/` directory**, or manifests that reference the wrong namespace —
  namespace is always `<project>-<repo>`, not something set independently in the manifests.

## Vault-side debugging

```
vault_auth_status
    # shows the logged-in identity's `policies` — the fastest way to see whether this user/role
    # even has access to kv/projects/<project>/* before debugging anything downstream

vault_exec { "args": ["kv", "list", "kv/projects/<project>"] }
    # what secrets exist under the project. Exit code 2 here usually means "empty path or no
    # list ACL" — it does NOT mean "wrong mount", don't go hunting for alternate mount paths

vault_exec { "args": ["kv", "get", "kv/projects/<project>/<app>"] }
    # read one secret's metadata + keys (values are redacted from the tool response by design —
    # see below, this is not a bug or something to work around)
```

Avoid `sys/mounts` for discovery — normal OIDC users usually get a 403 on it, which looks like a
broken setup but is just a permissions boundary that doesn't apply to `kv/`.

## If an `ExternalSecret` isn't producing a k8s `Secret`

Check, in the project's `deploy/` manifests:

- The `SecretStore`'s `spec.provider.vault.auth.kubernetes.role` matches the project name exactly.
- The `ExternalSecret`'s `dataFrom.extract.key` matches `projects/<project>/<app>` exactly
  (note: no `kv/` prefix inside this field — that's implied by the `SecretStore`'s `path: kv`).
- The `ServiceAccount` used is named **exactly** `vault` — that literal name is hard-coded into
  the Vault Kubernetes-auth role the platform generated for the project; a differently-named
  ServiceAccount will authenticate as nobody.
- The namespace actually has the `vault.sonar-corp.ru/project` label — this gets applied
  automatically on first sync, so an app that's never synced successfully won't have it yet,
  which blocks Vault auth in a way that looks unrelated to sync status.

## Secret values are redacted on purpose

`vault_exec`/`argocd_exec` output has secret values stripped by default — `kv get` shows keys and
metadata but not values, and `Secret` resources from `argocd_exec` have `data`/`stringData`
scrubbed too, including when embedded inside JSON-stringified manifests. This is intentional
platform-mcp behavior, not a bug to route around: attempts like `-field=` or `-format=table` on
Vault commands are explicitly rejected by the plugin because they'd bypass redaction. If secret
values are genuinely needed in the conversation, that requires the user to opt in at the MCP
server level (`PLATFORM_MCP_ALLOW_SECRET_VALUES=true`) — it's not something achievable per call,
and shouldn't be suggested as a quick workaround for a single debugging session.
