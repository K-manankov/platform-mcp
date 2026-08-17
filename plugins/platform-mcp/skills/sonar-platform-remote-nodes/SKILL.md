---
name: sonar-platform-remote-nodes
description: How and when to run a workload on a remote node of the sonar-prod Kubernetes cluster — a node outside the office network, joined over a WireGuard tunnel, whose value is unrestricted outbound access to resources blocked in Russia. Use whenever a pod needs to reach a blocked/geo-restricted external service, when the mihomo proxy isn't enough, when the user asks to "pin a pod to the remote node", "schedule on the node abroad", "why is my pod Pending on the remote node", or when a pod on a remote node has to talk to a pod in the main cluster. Covers the approval rule (Kirill signs off before anything lands there), the proxy-first default, why pod-to-pod over the CNI across the tunnel is discouraged, and the exact toleration/nodeSelector to write.
---

# Remote nodes on sonar-prod

A *remote node* is a cluster worker that does not live in the office network `192.168.88.0/24`.
It joins the cluster over a WireGuard tunnel, so from Kubernetes' point of view it is a normal
node, and from the network's point of view everything it does inside the cluster crosses a
long, thin, and fragile link.

The only reason such a node exists is **outbound reachability**: it sits where resources blocked
in Russia are reachable directly, without a proxy.

Remote nodes are marked at kubelet registration (`--register-with-taints`, `--node-labels` in the
`k8s_join` playbook) with both a taint and a matching label:

```
taint:  node.sonar-corp.ru/remote=true:NoSchedule
label:  node.sonar-corp.ru/remote=true
```

so nothing lands there by accident. Only two kinds of workload get past it: node-local agents
that must run everywhere (grafana-alloy is the example — see
`platform/grafana-alloy/values.yaml` in the `infra` repo), and workloads that were deliberately
placed there.

## When a workload belongs on a remote node

Use a remote node when **both** hold:

1. The pod has to reach resources blocked in Russia **frequently** — it's part of the workload's
   normal operation, not a one-off fetch at startup, and
2. the standard route (the mihomo VPN proxy) doesn't fit.

The default route is mihomo, not a remote node. Before proposing a remote node, check that the
proxy genuinely fails the case:

```yaml
env:
  - name: HTTP_PROXY
    value: http://mihomo.infra.sonar-corp.ru:7890
  - name: ALL_PROXY
    value: socks5://mihomo.infra.sonar-corp.ru:7890
  - name: NO_PROXY
    value: .svc.cluster.local,.cluster.local,10.0.0.0/8,192.168.88.0/24
```

Reasons the proxy legitimately doesn't fit: the client ignores proxy env vars and can't be
configured; the protocol isn't HTTP/SOCKS-carryable; the traffic volume or latency budget makes
routing everything through one proxy pod unreasonable; the remote service rejects the proxy's
exit addresses. "It would be simpler" is not one of those reasons — mihomo is the cheaper,
already-monitored path, and it doesn't put the workload behind a tunnel.

### Approval is mandatory

**A pod may be scheduled onto a remote node only with Kirill's explicit sign-off.** This is not
a formality to route around: remote-node capacity, tunnel bandwidth, and the blast radius of the
tunnel going down are all shared. If the user asks to pin something there, and the approval isn't
already in hand, say so and stop before committing the manifest change — prepare the change, let
them get the go-ahead, then land it.

## Talking to the rest of the cluster: internet, not CNI

**Pod-to-pod traffic across the tunnel via the CNI must be minimized.** It works — the pod network
spans the tunnel, and a `Service` DNS name resolves the same on both sides — but every packet
crosses WireGuard, the path is slow and loss-prone, and a tunnel hiccup turns into cluster-internal
errors that look nothing like a network problem.

Default design for a remote pod that needs to reach something in the main cluster (or vice versa):
go out over the ordinary internet.

- Address the peer by its **preconfigured, publicly resolvable domain name** (`*.sonar-corp.ru` or
  whatever public name the service is published under), not by a `*.svc.cluster.local` service
  name. Note that `*.infra.sonar-corp.ru` is **not** such a name: that zone resolves to the real
  hosts only from the corporate network / VPN, and a remote pod is outside both. Worse, a public
  wildcard answers for it, so the request doesn't fail cleanly — it quietly goes to the wrong
  host. If the peer has no public name yet, getting one published is part of the work.
- A bare IP is a last resort — acceptable only when no name exists yet and one can't be added;
  say so explicitly in the MR rather than leaving it as a silent shortcut.
- **TLS is mandatory** on that path, in both cases. Traffic leaving the cluster over the public
  internet is not covered by the tunnel's encryption. Use the ingress certificate; don't disable
  verification to make it work — if verification fails, fix the trust chain (cert-manager /
  the internal CA), don't paste `insecureSkipVerify`.

Reach for in-cluster `*.svc.cluster.local` across the tunnel only in genuinely exceptional cases:
no publicly reachable endpoint can exist for that peer, and the traffic is low-volume and
tolerant of the tunnel's latency and occasional loss. Call it out in the merge request.

## How to pin a pod to a remote node

Two things are required together. A toleration alone only makes the node *eligible* — the
scheduler will still happily put the pod on a normal worker. A `nodeSelector`/affinity alone will
leave the pod `Pending` forever, blocked by the taint.

```yaml
spec:
  template:
    spec:
      tolerations:
        - key: node.sonar-corp.ru/remote
          operator: Equal
          value: "true"
          effect: NoSchedule
      nodeSelector:
        node.sonar-corp.ru/remote: "true"
```

Select on the **label**, not on `kubernetes.io/hostname`: the label is what the join playbook puts
on every remote node, so the selector keeps working when the node is rebuilt or a second remote
node appears. Pin by hostname only when a workload genuinely must sit on one specific machine —
and then remember node names are **fully qualified domain names**
(`k8s-remote-worker-01.infra.sonar-corp.ru`); a short name matches nothing and the pod hangs in
`Pending` with no obvious error.

To see which nodes are remote:

```bash
kubectl get nodes -l node.sonar-corp.ru/remote=true
```

All of this goes into the project's `deploy/` manifests and ships through Argo CD like any other
change — no `kubectl apply`, no manual patching of a live Deployment.

### Things that change once a pod lives there

- **Storage.** The default `StorageClass` is local-path — the volume physically lives on the node.
  A PVC bound on a remote node pins the pod there permanently and is not reachable from the main
  workers. Don't plan on moving the workload back without moving its data.
- **The proxy env is now wrong.** A pod on a remote node reaches blocked resources directly.
  Leaving `HTTP_PROXY`/`ALL_PROXY` pointed at mihomo sends its traffic back through the tunnel
  into the office network and out again — the opposite of the point. Drop those vars.
- **Anything that must run on every node** needs the toleration too, or it silently skips the
  remote node: no errors, no unhealthy pods, just missing data. That's exactly how missing log
  collection was found — `DaemonSet` `desired=2` in a three-node cluster.
- **Logs and metrics already work**: grafana-alloy tolerates the taint and collects only its own
  node's logs; node-exporter from kube-prometheus-stack ships tolerant by default.

## Diagnosing

- Pod `Pending` right after being pinned → `kubectl describe pod`, look for
  `node(s) had untolerated taint {node.sonar-corp.ru/remote: true}` (missing toleration) or
  `node(s) didn't match Pod's node affinity/selector` (label value misspelled — it's the string
  `"true"`, not a bare YAML boolean — or a short hostname used instead of the FQDN).
- Pod scheduled onto an office worker despite the toleration → the `nodeSelector` is missing.
  A toleration permits, it never attracts.
- Pod running but the workload times out on cluster-internal calls → it's probably calling
  `*.svc.cluster.local` over the tunnel. Move it to the public domain + TLS route above.
- Everything on the node goes unreachable at once → suspect the tunnel, not the workload.
  Check the node's `Ready` condition and its `kubelet` heartbeat before debugging the app.
