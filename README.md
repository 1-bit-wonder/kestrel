<div align="center">

<img src="assets/kestrel-banner.svg" alt="Kestrel — single-host eBPF runtime security & observability" width="760" />

<p><em>The kernel-level visibility of Falco, with the live UI the kernel-native tools don't ship.</em></p>

![Svelte 5](https://img.shields.io/badge/Svelte%205-FF3E00?logo=svelte&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)
![eBPF](https://img.shields.io/badge/eBPF-1a1a1a?logo=linux&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-06B6D4?logo=tailwindcss&logoColor=white)
![Nix](https://img.shields.io/badge/Nix-5277C3?logo=nixos&logoColor=white)
![status](https://img.shields.io/badge/status-Phase%203%20·%20in%20progress-D6342B)

<a href="#running-the-app-dev"><b>Quickstart</b></a> ·
<a href="./SPEC.md"><b>Spec</b></a> ·
<a href="#dashboard-views"><b>Views</b></a> ·
<a href="#roadmap"><b>Roadmap</b></a>

</div>

Kestrel traces kernel events (process exec, file access, network connections)
with an **eBPF** agent and streams them to a **SvelteKit** web app that renders
a live activity feed, process tree, host overview, and a rule-based alert
engine. See [`SPEC.md`](./SPEC.md) for the full product/architecture document
and [`CLAUDE.md`](./CLAUDE.md) for the operational guide.

## Why it exists

The eBPF ecosystem is backend/CLI/Kubernetes-operator shaped. Falco — the
CNCF-graduated standard — famously ships **no UI of its own**. The gap between
"the kernel emits rich data" and "a human can actually read it" is the
full-stack sweet spot this project lives in. Deliberately **single-host** (not
Kubernetes) and **observe-only** (no enforcement) in v1.

## Architecture

```mermaid
flowchart TB
    subgraph host["Linux host · VM in dev, VPS in prod · kernel ≥ 5.8"]
        direction TB
        probes["eBPF probes (C)<br/>execve · openat · connect"]
        agent["Go agent — cilium/ebpf<br/>decode · enrich · batch"]
        ingest["/api/ingest<br/>Zod-validated at the boundary"]
        rules["rule engine"]
        hub["live hub"]
        db[("Postgres<br/>events · rules · alerts")]
        dash["SvelteKit dashboard<br/>live feed · tree · overview"]

        probes -- "ring buffer" --> agent
        agent -- "HTTP POST · JSON (Zod contract)" --> ingest
        ingest --> db
        ingest --> rules
        ingest --> hub
        hub -- "SSE" --> dash
    end
```

**The key deployment constraint:** the agent needs a real kernel, so it
**cannot** run on Cloudflare Workers (V8 isolates, no kernel). v1 co-locates
agent + app + Postgres on one host. See `SPEC.md` §2.

## Repository layout

| Path | What |
|---|---|
| [`/app`](./app) | SvelteKit app — event schema, ingest, SSE hub, dashboard views. **Built & runnable.** |
| [`/agent`](./agent) | Go userspace agent + eBPF C probes (execve/exit/openat/connect) + `/proc` snapshot. **Built; runs in the VM only.** |
| [`/infra`](./infra) | Nix dev VM (built) + `nixosTest`, Terraform/libvirt provisioning (Phase 4). |
| [`SPEC.md`](./SPEC.md) | Authoritative product & architecture spec. |

## Status

**Phase 3 — in progress.** Phase 2 must-haves (live feed, process tree, host
overview) are complete and verified live in the VM: the eBPF agent (`execve` +
`exit`, cilium/ebpf) traces a real kernel and streams events to the app, seeding
the tree with a `/proc` snapshot at startup. Phase 3 so far: the agent gained
**file-open (`openat`) and outbound-connection (`security_socket_connect`)
probes** (compile-verified; load-test pending in the VM), and the **network map
(8.3)** is built — a D3 force-directed process↔destination graph. Next up: the
sensitive-file monitor (8.4) and the rule engine + alerts (8.5). Probe work
stays in the dev VM, never the host.

## Dashboard views

Depth on a few views beats breadth done shallowly — six crisp views, built in
priority order (must-haves first).

| View | The question it answers | Status |
|---|---|---|
| **Live activity feed** (8.1) | *What's happening right now?* | ✅ built |
| **Process tree** (8.2) | *What spawned what?* | ✅ built |
| **Host overview** (8.6) | *One-screen status?* | ✅ built |
| **Network map** (8.3) | *What is this host talking to?* | ✅ built |
| **Sensitive-file monitor** (8.4) | *Did anything touch the files that matter?* | ◻️ planned |
| **Alerts & rules** (8.5) | *Tell me when something looks sketchy.* | ◻️ planned |

## Roadmap

- [x] **Phase 1 (app):** event schema · ingest · SSE hub · live feed · tests
- [x] **Phase 1 (agent):** `execve` probe → ring buffer → `cilium/ebpf` → `/api/ingest` *(in the VM)*
- [x] **Phase 2:** `exit` probe + `/proc` snapshot · process tree · host overview
- [~] **Phase 3:** ✅ file + connect probes · ✅ network map · ◻️ file monitor · ◻️ rule engine + alerts · ◻️ server-side process-tree cache · ◻️ property + event-delivery tests
- [ ] **Phase 4:** Nix dev VM · `nixosTest` kernel integration test · GitHub Actions CI
- [ ] **Phase 5:** VPS deploy (Terraform), agent + app + Postgres co-located
- [ ] **Phase 6 (stretch):** timeline/history · LLM "explain this alert" · enforcement · multi-host · k8s DaemonSet

## Running the app (dev)

```bash
cd app
pnpm install
pnpm dev            # http://localhost:5173
```

The app runs on the host; the agent runs in the dev VM and ships events to it.
To see a populated feed without the agent, opt into the synthetic generator:
`KESTREL_SYNTHETIC=1 pnpm dev`.

```bash
pnpm check          # svelte-check (types)
pnpm test           # vitest — schema + ingest unit tests
pnpm build          # production build (adapter-node)
```

The dev/test database is **PGlite** (Postgres compiled to WASM): no native
build, no separate server, same SQL dialect as the prod Postgres. It persists
to `app/kestrel-pgdata/` (gitignored); tests use an ephemeral in-memory DB.

### Try the pipeline by hand

```bash
# stream events (leave running in one terminal)
curl -N http://localhost:5173/api/stream

# post an event (in another) — appears live in the stream and the browser
curl -X POST http://localhost:5173/api/ingest -H 'content-type: application/json' \
  -d '[{"host":"demo","type":"exec","pid":42,"comm":"bash","cmdline":"bash -i"}]'
```

## Testing & verification

Three tiers, matched to where each class of bug lives (full detail in
[`SPEC.md`](./SPEC.md) §6–§7):

- **eBPF verifier — free.** The kernel proves every probe is memory-safe,
  bounded, and terminating before it will load — the riskiest code in the
  system, verified at load time for nothing.
- **Property-based tests (Phase 3).** `fast-check` drives the Zod event contract
  with adversarial/malformed events and asserts rule-engine invariants: no false
  match, deterministic verdicts, malformed input rejected at the boundary.
- **Event-delivery correctness (Phase 3).** Per-event sequence numbers + a client
  gap/dup detector + an ingest-flood test assert every event crosses
  ingest → SSE exactly once. (A formal TLA+ model was considered and
  deliberately deferred — not justified at single-host volume.)

Today: Vitest units (schema, ingest, overview, process tree, network graph) +
the agent's `procscan` parser and event `decode` helpers. Run `pnpm test` in
`/app`, `go test ./...` in `/agent`.

## Design tradeoffs

- **Single-host vs cluster** — deliberate scope choice; multi-host is a far
  stretch (`SPEC.md` §8.11).
- **Observe-only vs enforcement** — v1 never kills processes; the risk bar for
  inline blocking is much higher (`SPEC.md` §8.10).
- **`cilium/ebpf` vs `libbpfgo`** — pure Go, `CGO_ENABLED=0`, `bpf2go` workflow.
- **PGlite/Postgres vs SQLite vs ClickHouse** — Postgres dialect everywhere;
  fine under ~1M events, revisit ClickHouse beyond that (`SPEC.md` §10).
- **Verification for free** — the eBPF verifier statically proves every probe is
  memory-safe, bounded, and terminating before the kernel will load it. The
  riskiest code in the system is verified at load time at zero cost (`SPEC.md` §6).
