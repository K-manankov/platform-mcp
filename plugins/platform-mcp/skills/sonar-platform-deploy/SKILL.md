---
name: sonar-platform-deploy
description: How to deploy, release, sync, or roll back a project running on the sonar-prod Kubernetes platform (Argo CD, GitOps, via the platform-mcp plugin's argocd_exec tool). Use whenever the user wants to ship a change to sonar-prod, trigger an Argo CD sync, check whether a deploy went out, see an app's rollout/sync/health status, roll back a release, or asks things like "why hasn't my change shown up in the cluster" or "how do I release a new version." This is the GitOps flow — there is no manual kubectl apply on this platform.
---

# Deploying on sonar-prod

Everything in the `sonar-prod` cluster is managed by Argo CD pulling from Git — there is no
manual `kubectl apply`, ever, for either platform or project changes. A project's deploy is driven
entirely by what's committed under `deploy/` in its GitLab repo.

## The flow

1. Change the manifests under `deploy/` in the project's repo (image tag, config, replicas,
   whatever). Open a merge request, get it merged to the default branch.
2. Argo CD picks up the change on its own — either on its polling interval or immediately if
   auto-sync is enabled for that `Application`. No action needed from the agent or the developer
   beyond merging.
3. If a sync needs to happen right now rather than waiting, or auto-sync is off, trigger it
   explicitly (see below).

There's no separate "deploy pipeline" to invoke — merging the MR *is* the deploy. If the user asks
"how do I deploy", the honest answer is usually "merge your MR" plus "here's how to check it landed
and how to nudge it if it hasn't."

## Checking and driving deploys with `argocd_exec`

All of this goes through the `platform-mcp` plugin's `argocd_exec` tool (`{"args": [...]}`,
array form — never build a single string). Needs `argocd_login` first if not authenticated; check
with `argocd_auth_status`.

```
argocd_exec { "args": ["app", "list", "-o", "json"] }
    # every app the logged-in user can see, with sync/health status

argocd_exec { "args": ["app", "get", "<project>-<repo>"] }
    # detailed status for one app: sync state, health, per-resource state, recent sync history

argocd_exec { "args": ["app", "sync", "<project>-<repo>"] }
    # trigger a sync now — this MUTATES cluster state, so confirm with the user before calling it;
    # the tool itself will also prompt for confirmation since it's not a read command

argocd_exec { "args": ["app", "history", "<project>-<repo>"] }
    # list past sync revisions, to find a target for rollback

argocd_exec { "args": ["app", "rollback", "<project>-<repo>", "<history-id>"] }
    # roll back to a specific prior revision — also mutating, also needs confirmation
```

App name and namespace both follow the convention `<project>-<repo>` — that's fixed by the
platform's onboarding automation, not something to configure per-app.

## Boundaries

A project can only act within its own `AppProject` (their GitLab subgroup's apps). Infra-owned
Argo CD applications — `argocd`, `vault`, `cert-manager`, `ingress-nginx`, and the other
platform components — are hard-denied from `argocd_exec` mutation entirely (reads still work);
changing them requires a merge request into the `infra` repo itself, not a sync from the agent.
If a user asks to "just sync" one of those, redirect them to an MR against `infra`.

Namespace creation is automatic (`CreateNamespace=true` on first sync) — there's nothing to set up
manually there, and manually creating the namespace ahead of time isn't necessary or expected.

## If a sync doesn't go the way expected

That's a debugging question, not a deploy-mechanics one — see the **debug** skill for diagnosing
`OutOfSync`/`Degraded` status, reading logs, and common failure causes (bad node selectors,
missing `deploy/` directory, PV scheduling, etc).
