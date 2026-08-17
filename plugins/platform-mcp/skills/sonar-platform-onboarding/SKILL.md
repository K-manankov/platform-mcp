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
2. **Add a repo under that subgroup with a `deploy/overlays/` directory at its root.** This is
   usually a dedicated "deploy" repo (separate from application source), but it can be any repo —
   the marker Argo CD looks for is `deploy/overlays/` specifically, not a flat `deploy/`. A repo
   with manifests directly in `deploy/` is *not* picked up, by design: the Application path is
   `deploy/overlays/<env>`, and a flat layout would produce Applications pointing at nothing.

   The expected layout is a Kustomize base plus one overlay per environment — copy
   `examples/kustomize-project` from the `infra` repo as the starting point:

   ```
   deploy/
     base/                  full manifests, once
     overlays/test/         only the diff: replicas, resources, image tag, secrets
     overlays/prod/
   ```

   Argo CD auto-detects the tool from the overlay's contents: a `kustomization.yaml` means
   Kustomize, otherwise the flat manifests in that one directory (no recursion into
   subdirectories). Don't set `source.directory` anywhere — that forces the Directory source type,
   and `kustomization.yaml` then gets applied as a literal manifest, failing with a confusing
   "could not find kustomize.config.k8s.io/Kustomization ... make sure the CRD is installed".
   There is no such CRD and never will be.

That's it. Nothing is applied to the cluster by hand and no manifest needs to be copied into the
`infra` repo.

### Hard contract for the overlays

The namespace is shared by both environments and by every service in the project, so names are the
only thing keeping them apart. All three of these are mandatory, and skipping one fails in a way
that looks like a platform bug:

- **`nameSuffix: -<env>` in every overlay.** Without it both Applications claim the same object,
  and since both run `prune` + `selfHeal`, they overwrite each other indefinitely.
- **`includeSelectors: true` on the environment label.** Without it the Service selector stays
  identical across environments, and test's Service starts balancing onto prod's pods — names
  differ, labels don't.
- **Distinct names for distinct services.** The shared namespace no longer separates them, so
  `myapp` and `worker` must be two names, not two directories.

An environment listed by the platform but missing its `overlays/<env>` directory makes that
Application fail with `ComparisonError` — loudly, rather than being skipped silently.

## What happens automatically

The platform scans GitLab every ~3 minutes and reacts to what it finds:

- One Argo CD `AppProject` gets created per GitLab subgroup, named after the project. RBAC on it
  mirrors the GitLab subgroup roles (see above).
- One Vault group + KV access gets created for the subgroup, scoped to `kv/projects/<project>/*`
  — see the secrets skill for how to actually use it.
- One Argo CD `Application` gets created **per (repo, environment) pair** — so a repo with
  `deploy/overlays/` yields two: `<project>-<repo>-test` and `<project>-<repo>-prod`.
- **One namespace per project**, named `<project>` — not per repo and not per environment. It's
  created automatically on first sync (`CreateNamespace=true`) and labeled
  `vault.sonar-corp.ru/project: <project>`, which is what scopes the project's Vault access. The
  label can't be forged from the deploy repo: the platform applies it rather than reading it.

If a project has multiple microservices, each with its own repo, each repo gets its own pair of
`Application`s — but they all land in the same `<project>` namespace. There's no monorepo
requirement, and no per-service namespace either.

Adding a *new environment* is not a project-side change: it takes three edits, two of which are in
the `infra` repo (`clusters/sonar-prod/apps/projects.yaml` list element, the `vault-<env>`
ServiceAccount name in `platform/project-tenant/templates/vault.yaml`) plus the overlay directory
in every deploy repo. Direct users there rather than suggesting they can add one themselves.

## Files that only exist as reference, not as something to copy verbatim

The `infra` repo's `examples/` directory mixes two kinds of file, and confusing them wastes time:

- **Reference only** — `appproject-project.yaml`, `vault-project.yaml`. These show what the
  platform generates for a project named `demo`; they're explicitly documented as
  "human-readable contract, not a working manifest" (templated by the `project-tenant` Helm chart,
  not applied directly). Don't suggest copying them anywhere.
- **Meant to be copied into the project's own repo** — `examples/kustomize-project` (the whole
  `deploy/` skeleton, the starting point for onboarding), `examples/externalsecret-project.yaml`
  (see the secrets skill), `examples/keycloak-project.yaml` (see the keycloak skill), and
  `examples/ci` (GitLab CI templates, `include`d into the *service* repo rather than copied —
  see the deploy skill).

## Verifying onboarding worked

After creating the subgroup + deploy repo, wait a few minutes for the scan, then check with
`platform-mcp`'s Argo CD tools (requires `argocd_login` first if not already authenticated — check
with `argocd_auth_status`):

```
argocd_exec { "args": ["proj", "get", "<project>"] }                  # AppProject exists?
argocd_exec { "args": ["app", "list", "-o", "json"] }                  # expect TWO apps per repo
argocd_exec { "args": ["app", "get", "<project>-<repo>-test"] }        # sync/health, once it appears
```

Expect **two** Applications per repo (`-test` and `-prod`). Seeing only one, or neither, is the
signal something's off.

If the `Application`s don't show up after ~5 minutes, the most common causes are: the directory is
`deploy/` without `overlays/` underneath (the marker is `deploy/overlays/`), it isn't at the repo
root, the repo sits directly in `k8s-projects` instead of inside a `k8s-projects/<project>`
subgroup (that yields `project: k8s-projects`, which doesn't exist, and the Application fails
loudly — that's the contract check working), or Argo CD's clone credential (a deploy token scoped
to the whole `k8s-projects` group) doesn't have access — that last one is a platform-team-side
issue, not something to fix from the project side.

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
