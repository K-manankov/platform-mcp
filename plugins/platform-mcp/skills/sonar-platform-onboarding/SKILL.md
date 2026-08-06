---
name: sonar-platform-onboarding
description: How to onboard a new project or microservice onto the sonar-prod Kubernetes platform (Argo CD + Vault, GitOps via the platform-mcp plugin). Use whenever the user wants to create a new project on the platform, add a new service/app to the cluster, set up a deploy repository, register a repo with Argo CD, get their team a Vault/AppProject, or asks "how do I get my project onto sonar-prod" — even if they don't say "onboarding" explicitly. Also trigger for questions like "why isn't my new repo showing up in Argo CD" during initial setup.
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

## What to do next

- To actually get a change deployed once the `Application` exists, see the **deploy** skill.
- To give the app access to secrets, see the **secrets** skill (needs an `ExternalSecret` +
  `SecretStore` manifest added to the project's own `deploy/` directory).
- If something isn't syncing or the app looks unhealthy, see the **debug** skill.
