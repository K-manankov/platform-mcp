---
name: sonar-platform-onboarding
description: How to onboard a new project or microservice onto the sonar-prod Kubernetes platform (Argo CD + Vault, GitOps via the platform-mcp plugin). Use whenever the user wants to create a new project on the platform, add a new service/app to the cluster, set up a deploy repository, register a repo with Argo CD, get their team a Vault/AppProject, give their app outbound internet access, expose a port / set up an Ingress or LoadBalancer for their app, or asks "how do I get my project onto sonar-prod" — even if they don't say "onboarding" explicitly. Also trigger for questions like "why isn't my new repo showing up in Argo CD" during initial setup.
---

# Onboarding a project onto sonar-prod

`sonar-prod` is a Kubernetes cluster whose entire system layer (Argo CD, Vault, ingress, …) is
managed via GitOps in the `infra` repo. Application code never lives there — it lives in GitLab
group `k8s-projects`. A **project** = a GitLab subgroup `k8s-projects/<project>`. Everything in
this skill happens through GitLab and the `argocd_exec`/`vault_exec` tools from the `platform-mcp`
plugin — never by hand-editing `kubectl`/`vault` against the cluster.

Both Argo CD (`argocd.infra.sonar-corp.ru`) and Vault (`vault.infra.sonar-corp.ru`) are only
reachable over VPN — outside the VPN a public wildcard DNS record answers instead and requests
silently go nowhere. If any `argocd_exec`/`vault_exec` call times out or behaves strangely, check
VPN first (`dig +short argocd.infra.sonar-corp.ru` should return `192.168.88.106`).

## The onboarding contract (two steps, no platform repo changes)

Nothing needs to change in the `infra` (platform) repo to onboard a project — the whole contract
lives in GitLab:

1. **Create the GitLab subgroup** `k8s-projects/<project>`, and add members with the right roles.
   Role matters for Argo CD permissions later: Developer/Maintainer/Owner get sync/update/
   delete/create rights on the project's own apps; Reporter/Guest get view + logs only.
2. **Add a repo under that subgroup with a `deploy/` directory at its root.** This is usually a
   dedicated "deploy" repo (separate from application source), but it can be any repo — the only
   requirement Argo CD checks for is the existence of `deploy/` at repo root. Put raw Kubernetes
   manifests under `deploy/`; Argo CD recurses over everything in there (no fixed Helm/kustomize
   convention required).

That's it. Nothing is applied to the cluster by hand and no manifest needs to be copied into the
`infra` repo.

## What happens automatically

The platform scans GitLab every ~3 minutes and reacts to what it finds:

- One Argo CD `AppProject` gets created per GitLab subgroup, named after the project, scoped so
  the project can only manage resources in namespaces `<project>-*`. RBAC on it mirrors the
  GitLab subgroup roles (see above).
- One Vault group + KV access gets created for the subgroup, scoped to `kv/projects/<project>/*`
  — see the secrets skill for how to actually use it.
- One Argo CD `Application` gets created **per repo that has a `deploy/` directory**, named and
  namespaced `<project>-<repo>`. The namespace is created automatically on first sync
  (`CreateNamespace=true`) and gets labeled `vault.sonar-corp.ru/project: <project>` — this label
  is what scopes the project's Vault access to exactly its own namespaces, and it can't be forged
  from the deploy repo since the label is applied by the platform, not read from it.

If a project has multiple microservices, each with its own repo, each repo gets its own
`Application` and namespace as long as it has a `deploy/` directory — there's no single
"monorepo" requirement.

## Files that only exist as reference, not as something to copy verbatim

The `infra` repo's `examples/` directory (`appproject-project.yaml`, `vault-project.yaml`) shows
what the platform generates for a project named `demo` — they're explicitly documented as
"human-readable contract, not a working manifest" (they're templated by the `project-tenant` Helm
chart, not applied directly). Don't suggest copying them into `infra/`. The one example file that
**is** meant to be copied is `examples/externalsecret-project.yaml`, and it goes into the
project's own `deploy/` directory — see the secrets skill.

## Verifying onboarding worked

After creating the subgroup + `deploy/` repo, wait a few minutes for the scan, then check with
`platform-mcp`'s Argo CD tools (requires `argocd_login` first if not already authenticated — check
with `argocd_auth_status`):

```
argocd_exec { "args": ["proj", "get", "<project>"] }              # AppProject exists?
argocd_exec { "args": ["app", "list", "-o", "json"] }              # look for <project>-<repo>
argocd_exec { "args": ["app", "get", "<project>-<repo>"] }         # sync/health status, once it appears
```

If the `Application` doesn't show up after ~5 minutes, the most common causes are: `deploy/` isn't
actually at the repo root, the repo isn't under `k8s-projects/<project>` (a subgroup one level
deeper won't match), or Argo CD's clone credential (a deploy token scoped to the whole
`k8s-projects` group) doesn't have access — that's a platform-team-side issue, not something to
fix from the project side.

## Outbound internet access

Pods have no direct route to the internet — there's no default egress path out of the cluster.
Any app that needs to call an external API, download a package at runtime, etc. must be pointed at
the `mihomo` proxy explicitly:

```yaml
env:
  - name: HTTP_PROXY
    value: http://mihomo.infra.sonar-corp.ru:7890
  - name: ALL_PROXY
    value: socks5://mihomo.infra.sonar-corp.ru:7890
  - name: NO_PROXY
    value: .svc.cluster.local,.cluster.local,10.0.0.0/8,192.168.88.0/24
```

The `NO_PROXY` entry matters — without it, in-cluster service calls and calls to other
`*.infra.sonar-corp.ru` platform hosts get routed through the proxy too and typically just time
out. This is a per-app manifest change in the project's own `deploy/` directory, not something the
platform sets up automatically. See the **debug** skill's "Outbound internet access goes through
the mihomo proxy" section for the failover/dashboard details and how to tell a proxy misconfig
apart from an actual app bug.

## Exposing a port

There's no default inbound path into the cluster either — a `Service` alone (`ClusterIP`) is only
reachable from inside the cluster. Which mechanism to use depends on the protocol, and both are
manifests the project adds to its own `deploy/`, not something the platform sets up:

- **HTTP/HTTPS** — an `Ingress` on the shared `ingress-nginx` controller (`ingressClassName:
  nginx`), same as every platform component (argocd, vault, mihomo, …):

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: Ingress
  metadata:
    name: <app>
  spec:
    ingressClassName: nginx
    rules:
      - host: <app>.infra.sonar-corp.ru   # needs an A-record in FreeIPA pointing at .106
        http:
          paths:
            - path: /
              pathType: Prefix
              backend:
                service: { name: <app>, port: { name: http } }
  ```

  No `tls:` block is needed — leaving it unset makes ingress-nginx serve its own self-signed
  cert on 443 (one browser warning, same as argocd/vault/keycloak). Like every
  `*.infra.sonar-corp.ru` host, this is VPN-only; outside the VPN the public wildcard DNS answers
  instead and the request goes nowhere (see the debug skill's Step 0).

- **Any other TCP/UDP protocol** — ingress-nginx doesn't proxy plain TCP, so use a `LoadBalancer`
  `Service` instead and let MetalLB hand it an address from the pool. Free pool addresses:
  `.108`, `.114`, `.117`, `.118` (see the root `README.md`'s "Адресация" table for the current
  list — check it's still accurate, addresses get claimed over time). A plain `LoadBalancer`
  Service with no `loadBalancerIP` picks the next free one automatically:

  ```yaml
  apiVersion: v1
  kind: Service
  metadata:
    name: <app>-external
  spec:
    type: LoadBalancer
    selector: { app: <app> }
    ports:
      - port: <port>
        targetPort: <port>
  ```

  Only pin a specific address (`metallb.io/loadBalancerIPs`) and share it with an existing one
  (`metallb.io/allow-shared-ip`, matching annotation on both `Service`s, ports must not collide)
  if there's a real reason to reuse an existing IP/DNS name instead of getting a fresh one — see
  `platform/mihomo/service-external.yaml` in the `infra` repo for a worked example (mihomo's proxy
  port shares `.106` with ingress-nginx rather than taking its own address). For a new project,
  the plain pool-address form above is simpler and is the default choice.

## What to do next

- To actually get a change deployed once the `Application` exists, see the **deploy** skill.
- To give the app access to secrets, see the **secrets** skill (needs an `ExternalSecret` +
  `SecretStore` manifest added to the project's own `deploy/` directory).
- If something isn't syncing or the app looks unhealthy, see the **debug** skill.
