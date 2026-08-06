---
name: sonar-platform-secrets
description: How to manage secrets (API keys, database passwords, tokens) for a project on the sonar-prod Kubernetes platform, backed by HashiCorp Vault and delivered to pods via External Secrets Operator, through the platform-mcp plugin's vault_exec tool. Use whenever the user wants to add, read, list, or rotate a secret, wire a secret into a running pod or CI pipeline, or asks things like "where do I put my DB password", "how does my app get its API key", or "give my pipeline access to a Vault secret." Do not suggest committing secrets to Git, SOPS, or Sealed Secrets on this platform — Vault is the only supported store.
---

# Managing secrets on sonar-prod

Secrets live in HashiCorp Vault (`vault.infra.sonar-corp.ru`) and never in Git — not plaintext,
not encrypted-in-Git (SOPS/Sealed Secrets aren't used here). Access needs VPN and, for the
`vault_exec` tool, a logged-in session (`vault_login`, check with `vault_auth_status`).

## Path convention

Every project's secrets live under `kv/projects/<project>/<app>` — one path per app within the
project's subtree. A GitLab subgroup's members automatically get read+write on their own
`kv/projects/<project>/*` and nothing outside it (`kv/infra/*` and other projects' subtrees are
denied by the plugin's policy, separate from Vault's own ACLs).

## Writing a secret — mechanics

```
vault_exec { "args": ["kv", "put", "kv/projects/<project>/<app>", "DB_PASSWORD=...", "API_TOKEN=..."] }
```

This is a mutating command — confirm with the user before calling it (the tool will also prompt
for confirmation since `put` isn't a read verb). Multiple key=value pairs in one `put` fully
replace prior version's keys that aren't repeated — Vault KV v2 keeps version history, so nothing
is destructively lost, but don't assume `put` merges with existing keys.

**Important asymmetry vs. reading:** platform-mcp redacts secret *values* from `kv get`/`read`
responses (see below), but it has no equivalent protection on the *write* path — the value you
put into a `kv put` call's `args` is plain text in that tool call, same as any other argument.
Writing a secret necessarily means the value passes through the conversation once, on the way in.
That's unavoidable and fine for values you generated or the user pasted deliberately for this
purpose — just don't echo the value back afterwards, don't log it anywhere else, and don't include
it in any file you write outside of the one `vault_exec` call itself.

## Reading secrets — mechanics

```
vault_exec { "args": ["kv", "list", "kv/projects/<project>"] }
    # see what app paths exist, without reading any values

vault_exec { "args": ["kv", "get", "kv/projects/<project>/<app>"] }
    # metadata + key names for one secret — VALUES ARE REDACTED from the tool's response
```

Value redaction is deliberate platform-mcp behavior, not a limitation to route around: `-field=`
and non-JSON `-format=` flags are explicitly rejected because they'd print a bare value past the
redaction logic. If a value genuinely needs to reach the conversation, the user has to opt in at
the MCP server level (`PLATFORM_MCP_ALLOW_SECRET_VALUES=true`) — this is a deliberate,
session-level choice to make, not something to suggest as a one-off trick. By default, secret
values should be looked at directly in the Vault UI, not through the agent.

## Three common agent workflows

These map to the situations that actually come up when an agent is the one driving Vault, as
opposed to a human clicking through the UI.

### 1. Generating a secret and writing it (e.g. a new DB password, API signing key)

Generate a strong random value yourself (e.g. via `openssl rand -base64 32` or similar — don't
invent a "memorable" or low-entropy value), then write it directly:

```
vault_exec { "args": ["kv", "put", "kv/projects/<project>/<app>", "DB_PASSWORD=<generated-value>"] }
```

Confirm with the user *what* you're about to generate and store (key name, path, purpose) before
running it — they should approve the action, but they don't need to see or choose the value itself
for something like a DB password or internal signing key. After writing, tell the user it's done
and where it lives (`kv/projects/<project>/<app>`, key name) rather than repeating the value back —
there's no reason for a generated value to appear twice in the conversation. Point them at the
Vault UI if they need to see it later. This flow is most common right after onboarding a new app,
before its first deploy, or when rotating a credential the app owns end-to-end (nothing external
needs to be told the new value).

### 2. Taking a secret value from the user and writing it (e.g. a third-party API key they have)

Same `kv put` mechanics, but here the value is something the user already has and is handing to
you specifically to store — a Stripe key, a partner's API token, etc. Use it in the one
`vault_exec` call and don't do anything else with it: don't write it to a scratch file, don't
repeat it in your response, don't include it in a summary or commit message. If the user pastes
the value directly into chat, that's their call to make, but you shouldn't ask them to do that when
avoidable — for a single value, confirming "write `<KEY_NAME>` to `kv/projects/<project>/<app>`?"
without echoing the value back is enough. Once written, verify success with `kv get` (which will
correctly show the key name with the value redacted) rather than by re-reading the value.

### 3. Pulling existing secret values to configure a local dev environment (e.g. a local `.env`)

This is the one workflow that legitimately needs real values leaving Vault, so it requires the
session-level opt-in mentioned above: `PLATFORM_MCP_ALLOW_SECRET_VALUES=true` set for the
platform-mcp server, not something you can request per call. Confirm the user has that set (or ask
them to set it and restart the MCP connection) before attempting this — without it, `kv get` will
keep coming back with keys but no values, which looks like failure but is normal for the default
config in scenario 1/2 above.

Once opted in:

```
vault_exec { "args": ["kv", "get", "kv/projects/<project>/<app>"] }
```

will return real values. Write them straight into the target file (e.g. `.env`, `.envrc`) rather
than displaying them in the conversation first if that can be avoided — the point of pulling them
is to populate a file, not to surface them as chat text. Confirm the target file is git-ignored
before writing (check `.gitignore`, or add an entry if missing) — a local secrets file leaking into
a commit defeats the entire point of keeping secrets out of Git in the first place. This is
distinct from scenario 1/2: those write *to* Vault and should avoid ever displaying the value;
this one reads *from* Vault specifically so a human's local tooling can use it, and the value's
exposure is limited to that person's own machine, not written back to any shared file.

## Getting a secret into a running pod

Applications never talk to Vault directly. Instead, the project's `deploy/` directory (in its own
GitLab repo — never in `infra`) gets a copy of the `externalsecret-project.yaml` template from the
`infra` repo's `examples/` directory, which defines three objects:

1. A `ServiceAccount` named **exactly** `vault` — this literal name is hard-coded into the Vault
   Kubernetes-auth role the platform generates per project, so renaming it silently breaks auth.
   It carries no Kubernetes RBAC of its own; it exists purely as Vault's identity check.
2. A namespaced `SecretStore` pointing at Vault, with `auth.kubernetes.role` set to the project
   name.
3. An `ExternalSecret` with `dataFrom.extract.key: projects/<project>/<app>` (matching the
   `vault kv put` path above, without the `kv/` prefix — that's implied by the store's `path: kv`),
   producing a normal Kubernetes `Secret` that the app consumes the usual way
   (`envFrom.secretRef`).

Only three things typically need editing when adapting the template: the `role` (project name),
the `extract.key` (project/app), and the target `Secret` name — everything else can stay as-is.
Once merged (see the **deploy** skill for the GitOps flow), External Secrets Operator polls Vault
on the `ExternalSecret`'s `refreshInterval` and keeps the `Secret` in sync. Note a changed secret
value updates the `Secret` object but does **not** restart pods automatically — an app that only
reads env vars at startup needs a rollout restart to pick up a rotated value.

## CI pipeline access (GitLab CI, not a deployed pod)

Pipelines authenticate via GitLab CI `id_tokens`, not a stored Vault token, through a separate
`gitlab-ci` auth path:

```yaml
deploy:
  id_tokens:
    VAULT_ID_TOKEN:
      aud: https://vault.infra.sonar-corp.ru
  script:
    - export VAULT_ADDR=https://vault.infra.sonar-corp.ru
    - export VAULT_TOKEN="$(vault write -field=token auth/gitlab-ci/login role=<project> jwt=$VAULT_ID_TOKEN)"
    - vault kv get -field=DB_PASSWORD kv/projects/<project>/<app>
```

This runs inside the pipeline's own `vault` CLI, not through `platform-mcp` — the plugin's tools
are for interactive/agent use against the logged-in developer's own session, not for wiring into
CI. The role (`<project>`) here is provisioned by the same onboarding automation as the KV path —
see the onboarding skill.

## Out of scope for a project

`kv/infra/*` and Vault's own auth/policy configuration (`platform/vault-config/` in the `infra`
repo) aren't things a project can touch — they're managed via Git MR against `infra`, and any
manual `vault write` against them gets reverted by drift detection within an hour. If a user asks
for infra-level Vault changes, redirect them to an `infra` MR rather than attempting it via
`vault_exec`.
