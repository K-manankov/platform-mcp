---
name: sonar-platform-deploy
description: How to deploy, release, promote to prod, sync, or roll back a project running on the sonar-prod Kubernetes platform (Argo CD, GitOps, via the platform-mcp plugin's argocd_exec tool). Use whenever the user wants to ship a change to sonar-prod, promote a build from test to prod, trigger an Argo CD sync, check whether a deploy went out, see an app's rollout/sync/health status, roll back a release, or asks things like "why hasn't my change shown up in the cluster" or "how do I release a new version." Also covers wiring up the platform's GitLab CI templates in a service repo — the `.gitlab-ci.yml` include, the `DEPLOY_REPO`/`IMAGE`/`BUILD_CONTEXT` variables, and the `DEPLOY_PUSH_TOKEN` write credential the deploy job needs. This is the GitOps flow — there is no manual kubectl apply on this platform.
---

# Deploying on sonar-prod

Everything in the `sonar-prod` cluster is managed by Argo CD pulling from Git — there is no
manual `kubectl apply`, ever, for either platform or project changes. A project's deploy is driven
entirely by what's committed under `deploy/` in its GitLab repo.

## Two environments, one branch, one namespace

This is the single most important thing to get right, and it's unusual enough that generic
Argo CD knowledge gets it wrong:

- **Environments are directories, not branches.** `deploy/overlays/test` and `deploy/overlays/prod`
  in the *same* default branch of the deploy repo. There is no `test` branch and no `prod` branch
  in the deploy repo.
- **One `Application` per (repo, environment) pair**, named `<project>-<repo>-<env>` —
  e.g. `payments-billing-deploy-test` and `payments-billing-deploy-prod`.
- **The namespace is `<project>`** — just the project slug, shared by both environments and by
  every service in the project. It is *not* `<project>-<repo>` and not `<project>-<env>`.
  Environments coexist in that one namespace and are told apart only by resource names
  (`nameSuffix: -test` / `-prod`) and the `sonar-corp.ru/environment` label.
- **Auto-sync is always on** for project apps — `prune: true` and `selfHeal: true`, no exceptions,
  not a per-app setting. Anything that drifts from Git gets reverted.

Because the namespace is shared, an overlay that forgets `nameSuffix` makes both Applications
claim the same object, and with selfHeal on both they overwrite each other forever. That's a
contract violation in the deploy repo, not a platform bug — see the **onboarding** skill.

## The flow

1. Change the manifests under `deploy/overlays/<env>` in the project's repo. Open a merge request,
   get it merged to the default branch.
2. Argo CD picks up the change on its own — auto-sync is on, and the repo is rescanned about every
   3 minutes. No action needed beyond merging.
3. If a sync needs to happen right now rather than waiting, trigger it explicitly (see below).

There's no separate "deploy pipeline" to invoke — merging *is* the deploy. If the user asks
"how do I deploy", the honest answer is usually "merge your MR" plus "here's how to check it landed
and how to nudge it if it hasn't."

## Promoting test → prod

Promotion is **editing the image tag in `overlays/prod`**, not merging a branch. The point is that
exactly what's in the diff goes to prod, rather than everything that accumulated in an environment
branch.

Projects using the platform's CI templates (`examples/ci` in the `infra` repo, included into the
*service* repo's `.gitlab-ci.yml` — see **Wiring up the CI templates** below) get this automated:

- Push/merge to the service repo's default branch → image built and tagged with the commit's short
  SHA → that tag committed into `deploy/overlays/test`.
- Fast-forward merge of the service repo's default branch into its `prod` branch → the image is
  **not rebuilt**; a job verifies the tag already exists in the registry and, on manual approval,
  commits the same tag into `deploy/overlays/prod`.

So a `prod` branch may exist **in the service repo**; it decides which overlay the tag lands in.
It never means a second branch in the deploy repo. If a user talks about "merging to the prod
branch", clarify which repo they mean before advising.

The image tag is the commit SHA and is immutable by design — that's what makes prod run the exact
bytes that ran in test rather than a fresh rebuild of the same source. The cost is that promotion
must be fast-forward; a rebase or squash into `prod` changes the SHA, the image isn't found, and
the pipeline fails loudly with an explanation.

Projects not using the CI templates do the same thing by hand: one MR editing `newTag` in
`overlays/prod/kustomization.yaml`.

## Wiring up the CI templates

The templates live at `examples/ci/{build,deploy}.yml` in the `infra` repo
(`infra/k8s/platform` in GitLab) and are `include`d, never copied — so projects pick up fixes
without a re-sync. Everything needed to set them up is below; don't send the user to read the
`infra` repo for it.

The service repo's `.gitlab-ci.yml`, in full:

```yaml
include:
  - project: infra/k8s/platform
    ref: main
    file:
      - /examples/ci/build.yml
      - /examples/ci/deploy.yml

variables:
  DEPLOY_REPO: k8s-projects/<project>/deploy
```

`DEPLOY_REPO` is the only mandatory variable; the rest comes from GitLab's built-ins. The
templates define stages `build` and `deploy` and four jobs: `build:image` (kaniko, default branch
only), `verify:image` (`prod` branch, checks the tag exists in the registry — never rebuilds),
`deploy:test` (automatic) and `deploy:prod` (`when: manual`).

Tunable variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE` | `$CI_REGISTRY_IMAGE` | Full image name; must match `images[].name` in the overlays *literally* |
| `IMAGE_TAG` | `$CI_COMMIT_SHORT_SHA` | Don't override — immutability is what the whole scheme rests on |
| `DOCKERFILE` | `Dockerfile` | Relative to `BUILD_CONTEXT` |
| `BUILD_CONTEXT` | `.` | For monorepos, e.g. `services/api` |
| `DEPLOY_REPO_BRANCH` | `main` | The deploy repo has exactly one branch; leave it |
| `KANIKO_IMAGE` | `gcr.io/kaniko-project/executor:v1.23.2-debug` | See below |
| `ALPINE_IMAGE` | `alpine:3.20` | Base for the helper jobs |

### The write credential (the one manual step)

The deploy job pushes to a *different* repo, and `CI_JOB_TOKEN` can't do that. So:

1. In the **deploy repo**: Settings → Access tokens → role `Developer`, scope `write_repository`.
2. In the **`k8s-projects/<project>` subgroup**: Settings → CI/CD → Variables → `DEPLOY_PUSH_TOKEN`,
   **masked**, **protected unchecked** (the service repo's `prod` branch may not be protected, and
   a protected variable wouldn't be exposed to that job). Subgroup level, not repo level — one
   deploy repo per project, and every service in it pushes with the same token.

It must be a **project access token**, *not* a deploy token: GitLab deploy tokens have no
`write_repository` scope at all — only `read_repository` plus the registry scopes — so they
cannot push. If someone reports "there's no such scope in the Deploy tokens UI", that's this
mixup. The job clones as `https://oauth2:$DEPLOY_PUSH_TOKEN@$CI_SERVER_HOST/$DEPLOY_REPO.git`,
which is the access-token form. If the deploy repo's branch is protected, `Developer` can't push
either — use `Maintainer`, or allow `Developer` push in Protected branches.

(Argo CD's own clone credential is a different thing entirely: a read-only deploy token scoped to
the whole `k8s-projects` group, owned by the platform team. There, a deploy token is correct.)

### What the deploy job actually edits

It rewrites **only** `newTag` on the `images[]` entry whose `name` matches `$IMAGE` exactly, in
`deploy/overlays/<env>/kustomization.yaml`. If no entry matches, the job **fails loudly** rather
than committing nothing — a green pipeline that changed nothing is the worst outcome here. So the
image name must be written identically and in full in `base/deployment.yaml` and in both overlays.

The push retries up to 5 times with `git pull --rebase` in between: every service in a project
pushes to the same deploy repo, so racing on the default branch is expected, not an error.

### Multiple services in one repo

Each service gets its own `IMAGE`, `BUILD_CONTEXT` and its own pair of jobs, via `extends`:

```yaml
build:api:
  extends: build:image
  variables:
    BUILD_CONTEXT: services/api
    IMAGE: $CI_REGISTRY_IMAGE/api

deploy:api:test:
  extends: deploy:test
  variables:
    IMAGE: $CI_REGISTRY_IMAGE/api
  needs: [build:api]
```

Since the project's namespace is shared by all services and both environments, different services
must have different resource names — `myapp` and `worker`, not two `app`s in different directories.

### If `gcr.io` is unreachable

`gcr.io` may be blocked from the office network, so `build:image` can't pull kaniko. Cheapest fix
first: mirror the kaniko image into the project's own registry and override `KANIKO_IMAGE`;
otherwise point the runner at the `mihomo` proxy. Do **not** propose docker-in-docker instead of
kaniko — it needs a privileged runner, i.e. effectively root on the node.

## Checking and driving deploys with `argocd_exec`

All of this goes through the `platform-mcp` plugin's `argocd_exec` tool (`{"args": [...]}`,
array form — never build a single string). Needs `argocd_login` first if not authenticated; check
with `argocd_auth_status`.

```
argocd_exec { "args": ["app", "list", "-o", "json"] }
    # every app the logged-in user can see, with sync/health status

argocd_exec { "args": ["app", "list", "-l", "sonar-corp.ru/environment=prod"] }
    # only prod apps. The environment labels (sonar-corp.ru/environment, .../project,
    # .../repository) live on the Application, never on the namespace — the namespace is
    # shared by both environments, so an env label there would be a lie

argocd_exec { "args": ["app", "get", "<project>-<repo>-<env>"] }
    # detailed status for one app: sync state, health, per-resource state, recent sync history

argocd_exec { "args": ["app", "sync", "<project>-<repo>-<env>"] }
    # trigger a sync now — this MUTATES cluster state, so confirm with the user before calling it;
    # the tool itself will also prompt for confirmation since it's not a read command

argocd_exec { "args": ["app", "history", "<project>-<repo>-<env>"] }
    # list past sync revisions
```

Always include the environment suffix. `app get payments-billing-deploy` matches nothing —
that Application does not exist, only the `-test` and `-prod` ones do.

## Rolling back

**`argocd app rollback` is the wrong tool here.** Project apps run with `automated` + `selfHeal`,
so a rollback either gets refused or is immediately undone when Argo re-applies what's in Git.
Reaching for it produces a confusing "it rolled back and then came back" report.

The durable rollback is **in Git**: revert the commit that moved the tag, or set `newTag` in
`overlays/<env>` back to the previous SHA, and merge. Argo picks it up the same way it picked up
the bad version. Since tags are immutable commit SHAs, the previous good tag is sitting right there
in the deploy repo's git history — `git log -p deploy/overlays/prod/kustomization.yaml` shows every
promotion in order.

If the user needs the bleeding stopped faster than an MR can land, scaling down or the app's own
feature flag is the stopgap — but say plainly that anything done to the live cluster gets reverted
by selfHeal within the sync interval, so it buys minutes, not a fix.

## Boundaries

A project can only act within its own `AppProject` (their GitLab subgroup's apps). Infra-owned
Argo CD applications — `argocd`, `vault`, `cert-manager`, `ingress-nginx`, and the other
platform components — are hard-denied from `argocd_exec` mutation entirely (reads still work);
changing them requires a merge request into the `infra` repo itself, not a sync from the agent.
If a user asks to "just sync" one of those, redirect them to an MR against `infra`.

Permissions do **not** distinguish environments: whoever can sync `test` can sync `prod`, and the
`AppProject`, namespace, Vault policy and Keycloak client are all shared per project. That's a
deliberate platform decision, not an oversight — don't propose per-environment RBAC as if it were
a config toggle.

Namespace creation is automatic (`CreateNamespace=true` on first sync) — there's nothing to set up
manually, and pre-creating it isn't necessary or expected.

## If a sync doesn't go the way expected

That's a debugging question, not a deploy-mechanics one — see the **debug** skill for diagnosing
`OutOfSync`/`Degraded` status, reading logs, and common failure causes (missing overlay directory,
bad node selectors, PV scheduling, etc).
