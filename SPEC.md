# SPEC.md — Single-Host eBPF Runtime Security & Observability Dashboard

> Working title: **Kestrel** (a small, sharp-eyed hunter — rename freely)
>
> A single-host Linux runtime-security and observability tool. An eBPF agent
> traces kernel events (process exec, file access, network connections) and
> streams them to a SvelteKit web app that renders a live activity feed,
> process tree, network map, sensitive-file monitor, and a rule-based alert
> engine — the friendly UI that kernel-native tools like Falco deliberately
> don't ship.

---

## 1. Purpose & positioning

### What this is
A focused, single-host security observability tool. The kernel collects rich
low-level events via eBPF; the web app turns that firehose into views a human
can reason about.

### Why it exists (the portfolio thesis)
- **The differentiation is the layer nobody else builds.** The eBPF ecosystem
  is backend/CLI/Kubernetes-operator shaped. Several flagship tools have weak
  or no frontend — Falco famously has none of its own and points users at a
  paid enterprise UI. The gap between "kernel emits rich data" and "a human
  sees it well" is exactly the full-stack sweet spot.
- **It proves range.** Kernel-level C/eBPF + a Go userspace agent + a modern
  SvelteKit full-stack app + IaC + tests. Very few portfolios touch the kernel
  at all.
- **It targets a hot, non-saturated niche.** eBPF crossed from "experimental"
  to "industry standard" in 2025–26; hyperscalers run it in production and
  certifications are forming. But the *portfolio* space around it is wide open.

### Deliberate non-goals
- **Not Kubernetes.** Every major tool (Cilium, Hubble, Pixie, Tetragon)
  assumes a cluster. Going single-host sidesteps enormous operational
  complexity, is far easier to demo, and is still genuinely useful. Multi-host
  is a future stretch, not v1.
- **Not trying to out-feature Falco/Sysdig.** Depth on a few views beats
  breadth done shallowly. Six crisp views > twenty half-built ones.
- **Not an enforcement tool (initially).** v1 observes and alerts. Inline
  enforcement (killing processes) is a clearly-marked stretch goal because it
  raises the risk and complexity bar substantially.

### Positioning one-liner
"A single-host runtime-security dashboard built on eBPF — the kernel-level
visibility of Falco with the live UI the kernel-native tools don't bother with,
provisioned reproducibly as code and tested with real VM integration tests."

---

## 2. Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│ Linux host (VM in dev, VPS in prod) — kernel >= 5.8             │
│                                                                  │
│  ┌──────────────┐   ring     ┌────────────────┐                 │
│  │ eBPF probes  │  buffer     │ Go agent       │                 │
│  │ (kernel, C)  ├────────────►│ (cilium/ebpf,  │                 │
│  │ execve/open/ │  events     │  userspace)    │                 │
│  │ connect/...  │             │ - decode       │                 │
│  └──────────────┘             │ - enrich       │                 │
│                               │ - batch        │                 │
│                               └───────┬────────┘                 │
│                                       │ HTTP/WebSocket (JSON)     │
│                                       ▼                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ SvelteKit app (Node adapter)                            │    │
│  │  /server  ingest endpoint, rule engine, SSE/WS hub      │    │
│  │  +page.server / load  dashboard data                    │    │
│  │  Svelte 5 components  feed, tree, map, alerts           │    │
│  └───────────────┬─────────────────────────────────────────┘    │
│                  │                                               │
│                  ▼                                               │
│           ┌────────────┐                                         │
│           │ Postgres   │  event history, rules, alerts           │
│           │ (or SQLite)│                                         │
│           └────────────┘                                         │
└──────────────────────────────────────────────────────────────────┘
```

### The critical deployment constraint
The eBPF agent **must** run on a real Linux host with kernel access (kernel
>= 5.8 for full features). This means **Cloudflare Workers cannot run the
agent** — Workers are V8 isolates with no kernel. Two viable topologies:

1. **Co-located (simplest):** agent + SvelteKit (Node adapter) + Postgres all
   on one VPS. Recommended for v1.
2. **Split:** agent on the monitored VPS pushes events to a SvelteKit app
   deployed on Cloudflare Workers (`adapter-cloudflare`) backed by D1/Neon.
   More moving parts; a good "I understand where each piece must run" talking
   point but not necessary for v1.

Either way, knowing *why* the split exists is itself a strong interview point.

---

## 3. Tech stack

| Layer | Choice | Rationale / alternative |
|---|---|---|
| eBPF probes | C, compiled with clang/LLVM | The standard. `bpftrace` for the learning on-ramp. |
| Userspace agent | **Go + `cilium/ebpf`** | Pure Go, no CGo (`CGO_ENABLED=0`), MIT, used by Tetragon & Inspektor Gadget. Uses `bpf2go` to compile C and generate Go bindings. Alt: `libbpfgo` (fuller libbpf API but CGo build friction). |
| Web framework | **SvelteKit** (Svelte 5 runes) | Full-stack: routing + `load` + form actions + server endpoints. Templating close to vanilla HTML/CSS. |
| Language | TypeScript | Non-negotiable for hireable work. |
| Styling | Tailwind CSS (or scoped `<style>`) | Tailwind = job-market default; Svelte scoped styles if leaning vanilla. |
| Charts/graph | D3 (network/process graphs), a lightweight chart lib for time-series | Force-directed graphs for process tree & network map. |
| DB | Postgres (prod), SQLite (dev option) | Drizzle ORM for type-safe, schema-to-app types. |
| Real-time | SSE (primary) or WebSocket | SSE is lighter for one-directional event push. |
| Deployment | VPS (Hetzner/Fly.io) via Node adapter; optionally Workers for the app tier | Agent needs a real kernel. |
| IaC | **Nix** (dev VM + VM integration tests) + **Terraform/libvirt** (VM & VPS provisioning) | Nix = reproducibility & your existing strength; Terraform = recognized industry IaC signal. |
| Tests | Vitest (unit), Playwright (e2e), NixOS `nixosTest` (kernel integration) | The VM integration test is the standout. |
| CI/CD | GitHub Actions | Even a basic pipeline sets the project apart. |

---

## 4. Local development environment

### Safety model
Never load unproven probes on the daily-driver host. Develop inside a
**throwaway Linux VM with its own kernel**. The eBPF verifier already rejects
programs that could crash/hang the kernel (no unbounded loops, no arbitrary
pointer deref), so the realistic dev risks are "needs root" and "bad probe
wastes resources" — the VM gives clean teardown and peace of mind.

> **Containers are NOT the safety boundary.** A privileged Docker container
> shares the *host* kernel, so a probe loaded there attaches to your real
> desktop's kernel. Use a VM (own kernel) for isolation; Docker is fine for
> packaging *inside* the VM.

### Recommended setup
- **QEMU/KVM** guest (near-native speed via hardware accel), current Ubuntu or
  NixOS, kernel >= 5.8. Manage via `virt-manager` (GUI) or `virsh`/Terraform
  (CLI/IaC).
- **Snapshots** before each probe test → instant rollback.
- Edit on host, sync into VM (Lima-style) or edit in-VM — your call.

### Toolchain (install in the VM)
```
clang llvm libelf-dev zlib1g-dev linux-headers-$(uname -r)
bpftool bpftrace
go (latest)            # agent
go install github.com/cilium/ebpf/cmd/bpf2go@latest
node + pnpm            # SvelteKit
postgres (or sqlite)
```

### The bpftrace-first on-ramp (do this before writing any C/Go)
Prove the technology end-to-end with one-liners before investing in the agent:
```
# Watch every process exec, live:
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%s %d -> %s\n", comm, pid, str(args->filename)); }'
```
If watching real kernel events this way is exciting rather than a slog, proceed
to the compiled agent. If not, the non-eBPF fallback (log parsing / userspace
APIs) gets ~70% of the impressiveness for far less pain.

---

## 5. IaC layer

Treat this as a **phase added after** the core agent→dashboard loop works —
don't yak-shave provisioning before tracing a single syscall.

### Nix / NixOS (primary reproducibility layer — your strength)
- `configuration.nix` declares kernel version, full eBPF toolchain, the agent,
  and the app — one reproducible spec.
- `nixos-rebuild build-vm` turns that config into a runnable QEMU VM in one
  command. Throwaway, version-controlled, exact kernel pinned (eBPF is
  kernel-version-sensitive, so this is substantive, not cosmetic).
- **`nixosTest` VM integration tests (the differentiator):** declaratively boot
  a VM, load the probe, trigger an `execve`, assert the dashboard received the
  event — an *integration test for kernel-level code*, runnable in CI. Almost
  no portfolio demonstrates this. Stretch: matrix-test across kernel versions.

### Terraform + libvirt (recognized industry IaC signal)
- `dmacvicar/libvirt` provider declares QEMU/KVM domains/disks/networks in HCL.
- Same Terraform (different provider) provisions the **prod VPS** (Hetzner/Fly),
  tying local and prod together.
- Pairs with Nix rather than competing: Terraform provisions the box, Nix (or
  cloud-init) configures the inside.

### Considered but not used (document in README as maturity signal)
- **Vagrant** — classic disposable-dev-VM tool; redundant given Nix.
- **Ansible** — config management; overlaps with Nix's declarative config.

---

## 6. The eBPF agent

### Probe targets (start with ONE, expand)
| Event | Hook | Why |
|---|---|---|
| Process exec | tracepoint `sys_enter_execve` / `sched_process_exec` | The spine — what ran, args, parent. |
| File open | tracepoint `sys_enter_openat` / `do_sys_openat2` kprobe | Sensitive-file access. |
| Network connect | kprobe `tcp_connect` / `security_socket_connect` | Outbound connection map. |
| New listening socket | kprobe on `inet_listen` | Detect unexpected servers. |
| Privilege change | tracepoint on `setuid`/`setgid` family | Privilege-escalation signal. |
| Module load | `init_module` / `finit_module` | Kernel tampering signal. |

### Build workflow (cilium/ebpf + bpf2go)
1. Write probe in restricted C (e.g. `exec.bpf.c`), output events to a
   **ring buffer** (`BPF_MAP_TYPE_RINGBUF`).
2. `bpf2go` compiles the C and generates typed Go loader bindings.
3. Go agent: `rlimit.RemoveMemlock()` (kernels <5.11), load objects, attach via
   `link` subpackage, read ring buffer, decode events.
4. Enrich in userspace: resolve PID→process metadata, container ID if present,
   user, cmdline; maintain a process-tree cache from exec/exit events.
5. Batch + ship to SvelteKit ingest endpoint (HTTP POST for history, WS/SSE
   upstream for live). `CGO_ENABLED=0` keeps builds clean.

### CO-RE (Compile Once, Run Everywhere)
Use BTF/CO-RE so the probe is portable across kernel versions; cilium/ebpf
handles CO-RE relocations at load time (kernel BTF auto-loaded from
`/sys/kernel/btf/vmlinux` on 5.2+). Saves recompiling per kernel.

### Event schema (shared contract: agent ↔ app)
```jsonc
{
  "id": "uuid",
  "ts": "2026-06-25T12:00:00.000Z",
  "host": "hostname",
  "type": "exec | file_open | net_connect | listen | priv_change | module_load",
  "pid": 1234,
  "ppid": 1001,
  "uid": 1000,
  "user": "www-data",
  "comm": "curl",
  "exe": "/usr/bin/curl",
  "cmdline": "curl http://1.2.3.4/x",
  "container_id": "abc123 | null",
  // type-specific:
  "file_path": "/etc/shadow",            // file_open
  "flags": "O_RDONLY",                   // file_open
  "dest_ip": "1.2.3.4", "dest_port": 80, // net_connect
  "proto": "tcp"                         // net_connect
}
```

---

## 7. The web app (SvelteKit)

### Server layer (`/server`)
- **Ingest endpoint** (`+server.ts`): receives batched events from the agent,
  validates (Zod), writes to Postgres (Drizzle), runs them through the rule
  engine, pushes matches + raw events to the live hub.
- **Live hub**: SSE endpoint streaming events to connected dashboards (filter
  params via query). WebSocket alternative if bi-directional control is added.
- **Rule engine**: evaluates each event against active rules (see §8.5).
- **`load` functions**: feed each route its initial data (recent events,
  current process tree snapshot, active alerts, summary counts).
- **Form actions**: create/edit/toggle rules; acknowledge/resolve alerts.

### Data access
Drizzle schema → types flow into server routes and components for end-to-end
type safety. Tables: `events`, `rules`, `alerts`, `hosts` (forward-looking),
optional `processes` snapshot/materialized cache.

---

## 8. Dashboard views (the product)

> Build order: **must-haves (8.1, 8.2, 8.6) end-to-end first** → then the
> security-credibility views (8.3, 8.4, 8.5) → then stretch (8.7+).

### 8.1 Live activity feed — *"what's happening right now?"* (MUST-HAVE)
Real-time stream of events, newest first, filterable by type/process/user.
Backed by SSE. The spine of the app and the core real-time showpiece.

### 8.2 Process tree / explorer — *"what spawned what?"* (MUST-HAVE)
Live parent→child tree from `execve` chains (D3 tree/force layout). Visually
striking and security-relevant: you can *see* a shell spawn curl spawn
something. Click a node → drill-down (its files, connections, children,
lifetime).

### 8.3 Network connection map — *"what is this host talking to?"*
Force-directed graph: process nodes → destination IP/port nodes, grouped by
process. Makes "why is *that* process talking to *that* address?" legible.
Optional GeoIP enrichment for destination country.

### 8.4 Sensitive-file-access monitor — *"did anything touch the files that matter?"*
Focused view tracking access to flagged paths (`/etc/shadow`, SSH keys,
`/tmp` & `/dev/shm` executions, app config). Narrow, high-signal.

### 8.5 Alerts / rules panel — *"tell me when something suspicious happens"*
Small rule engine over the event stream + a triggered-alerts panel. Starter
rules that read as real security logic:
- Process executed from `/tmp` or `/dev/shm`.
- Shell (`bash`/`sh`) spawned by a web-server process (classic reverse-shell).
- Unexpected outbound connection from a service that shouldn't make them.
- Sensitive file read by an unusual process.
- New listening socket on an unexpected port.
Rules are user-editable via form actions (condition builder or simple
expression). This view most signals security-domain understanding.

### 8.6 Host overview / summary — *"one-screen status"* (MUST-HAVE)
Landing view: events/sec, active processes, connection count, alerts in last
hour, busiest processes, small time-series sparklines. Where time-series
charting pays off.

### 8.7 Timeline / history (STRETCH)
Query stored events over a time range ("everything between 2:00–2:05"), with a
scrubber. Turns the tool from live-only into forensic.

### 8.8 Per-process syscall profile (STRETCH)
Syscall-frequency breakdown per process — a mini profiling view.

### 8.9 "Explain this alert" — LLM integration (STRETCH, high-signal)
When a rule fires, an LLM summarizes the process chain in plain English:
*"A bash shell was spawned by nginx, which then connected to an external IP —
consistent with a reverse shell."* Non-gimmicky AI: turns raw kernel events
into a human-readable security narrative. Hits the "AI fluency" hiring signal
with a real purpose. (If app tier is on Workers, this is a natural place to use
the Anthropic API or web-search-augmented summaries.)

### 8.10 Inline enforcement (FAR STRETCH)
Move from observe-only to blocking (Tetragon-style kill-before-syscall). Raises
risk/complexity sharply; clearly mark as experimental. Only after everything
else is solid.

### 8.11 Multi-host (FAR STRETCH)
Agents on several hosts reporting to one dashboard; host selector + fleet
overview. This is the jump toward what the cluster-native tools do — large
scope, deliberately deferred.

---

## 9. Phased roadmap

Each phase ends with something that *works* — never all-backend-then-all-frontend.

**Phase 0 — Spike & on-ramp**
- Nix/QEMU VM with toolchain + snapshot. bpftrace one-liners watching `execve`.
- Decision gate: enjoy the kernel layer? Proceed. If not, pivot to non-eBPF.

**Phase 1 — One probe, end-to-end (the core loop)**
- C `execve` probe → ring buffer → Go agent (cilium/ebpf + bpf2go) prints events.
- SvelteKit ingest endpoint + Postgres + SSE → **live activity feed (8.1)**.
- Deliverable: real kernel events appear live in a browser. This is the proof.

**Phase 2 — Process tree + overview (must-haves complete)**
- Agent maintains process-tree cache from exec/exit. **Process tree (8.2)**.
- **Host overview (8.6)** with summary counts + sparklines.
- Vitest unit tests for the rule/decode logic; first Playwright e2e.

**Phase 3 — Security credibility**
- Add file-open + connect probes. **Network map (8.3)**, **file monitor (8.4)**.
- **Rule engine + alerts panel (8.5)** with the starter rules.

**Phase 4 — IaC + tests (infra signal)**
- Terraform/libvirt provisioning for the VM. NixOS `nixosTest` integration test
  (boot VM → load probe → trigger exec → assert dashboard got it).
- GitHub Actions: lint, unit, e2e, and the VM integration test.

**Phase 5 — Deploy for real**
- Provision VPS (Terraform). Agent + app + Postgres co-located (topology 1).
- Or split: app on Workers + agent pushing events (topology 2).
- README with architecture diagram + the "why each piece runs where" narrative.

**Phase 6 — Stretch, pick by interest**
- Timeline/history (8.7), syscall profile (8.8), **LLM "explain alert" (8.9)**,
  enforcement (8.10), multi-host (8.11).

---

## 10. README narrative (write alongside the repo)

The README is part of the deliverable. Cover:
- The thesis: kernel-level visibility + the UI kernel-native tools lack.
- Architecture diagram + the **deployment-constraint story** (why the agent
  can't run on Workers; where each piece must live).
- The **tradeoffs** section — knowing your own limits reads as senior:
  - single-host vs cluster (deliberate scope choice);
  - Postgres vs ClickHouse for event volume (fine under ~1M events; when you'd
    migrate);
  - cilium/ebpf vs libbpfgo (pure-Go/no-CGo vs fuller libbpf API);
  - observe-only vs enforcement (risk bar);
  - IaC tools considered (Vagrant/Ansible) and why Nix + Terraform chosen.
- A short demo GIF/video of live events flowing in.

---

## 11. Risk register

| Risk | Mitigation |
|---|---|
| eBPF/C learning curve | bpftrace-first on-ramp; one probe before many; CO-RE to avoid per-kernel rebuilds. |
| Highest-difficulty option attempted | Phased so the core loop (Phase 1) is a complete, demoable win on its own. |
| Kernel-version portability | CO-RE/BTF; pin kernel in Nix; matrix test if time allows. |
| Scope creep (it's ambitious) | Must-haves first; everything in §8.7+ is explicitly optional. |
| Running experimental probes | VM with own kernel + snapshots; never the host; never rely on a container as the boundary. |
| Deploy confusion (Workers can't run agent) | Documented topology; co-located VPS for v1. |

---

## 12. Quick reference — key facts baked in

- eBPF needs **kernel >= 5.8** for full features; CO-RE auto-BTF on **5.2+**;
  `RemoveMemlock` needed below **5.11**.
- Agent library: **github.com/cilium/ebpf** (pure Go, `CGO_ENABLED=0`,
  `bpf2go` workflow).
- The agent host must be a **real Linux box** (VM in dev, VPS in prod) — not
  Cloudflare Workers.
- Build order discipline: **feed → tree → overview** (must-haves) before the
  rest.

---

## Appendix A — Product / SaaS hypothesis

> Status: **hypothesis, not a commitment.** This appendix documents a possible
> commercial path so the project is *designed* to keep that option open —
> without distorting it away from its primary purpose as a portfolio piece. The
> project's value as a hiring signal does **not** depend on any of this being
> true.

### A.1 The honest market reality

The "nothing like this exists" framing does **not** survive research, and the
spec should be honest about that:

- **The open-source core already exists and dominates.** Falco is
  CNCF-graduated, free, 175M+ downloads, and explicitly runs on plain hosts —
  not Kubernetes-only. It monitors hosts, containers, clusters, and cloud via
  eBPF. The technology layer of this idea is effectively commoditized.
- **eBPF runtime sensors already target standalone Linux/VMs**, not just
  clusters (OX, Sysdig, Orca all deploy to EC2/Linux hosts).
- **The commercial tier is saturated and well-funded:** Sysdig (founded by
  Falco's creators), Aqua, Wiz, SentinelOne, Prisma/Palo Alto, Orca, ARMO,
  Lacework, Red Hat/StackRox. This is one of the most contested areas in
  security.

**Conclusion:** there is no technology whitespace. "Build it and they'll come
because nothing exists" is not supported.

### A.2 The real (narrower) gap

The recurring complaint across the research is **not** "no tools exist" — it's
that existing tools are **too complex, too enterprise, too noisy, and too
Kubernetes-shaped for small operators**:

- Falco: powerful but steep learning curve, needs tuning at scale, and ships
  **no UI of its own** (points users to paid enterprise UIs).
- Commercial CNAPPs: enterprise pricing "challenging for smaller teams,"
  platform breadth = complexity, alert fatigue without careful tuning.
- Nearly the whole market assumes **Kubernetes-at-scale** (thousands of
  workloads, multi-cluster, multi-cloud).

**The underserved segment is concrete:** individuals / small teams running a
handful of plain Linux VPSes — indie hackers, small SaaS, agencies,
homelabbers, single-app shops — who find Falco too fiddly, the enterprise
CNAPPs too expensive and too cluster-centric, and just want *"tell me if
something sketchy happens on my box, with a UI I can actually read."*

The gap is in **packaging, simplicity, and price point — not capability.**

### A.3 The analogy that makes it credible

This is the **Plausible/Umami vs Google Analytics** pattern, applied to runtime
security. Not "no analytics existed," but "the incumbents were bloated, and a
simple, well-designed, fairly-priced alternative for smaller operators won a
real audience." Fathom/Pirsch did the same. The wedge is *experience and
pricing for the small operator*, not detection sophistication.

### A.4 Product shape (if pursued)

- **Wedge:** dead-simple install (one command, one agent), great UI out of the
  box, **sane default rules so there's no tuning cliff**, low flat pricing.
  Compete on the experience Falco doesn't give and Sysdig won't sell cheaply.
- **Target:** indie / SMB / agency Linux-VPS operators. **Explicitly NOT**
  Kubernetes-at-scale — do not try to out-Sysdig Sysdig.
- **AI "explain this alert" (8.9) becomes a core differentiator, not a
  flourish.** Alert fatigue and "low-level signals without clarity" is the #1
  complaint in the research; plain-English explanations directly address it for
  non-expert operators.
- **Positioning:** "Runtime security for people who don't have a security team."

### A.5 Risks (stated plainly)

| Risk | Note |
|---|---|
| Falco is free & capable | Caps pricing power; invites "why not just run Falco?" Answer must be UI + simplicity + defaults + support. |
| Security SaaS demands trust | Compliance, reliability, on-call — heavy for a solo founder. |
| Incumbents can move down-market | Sysdig et al. could target SMB. |
| Selling security to small ops is hard | They under-invest in security precisely because they're small. |
| Liability / stakes | A missed detection in a paid security product carries reputational/legal weight an analytics tool doesn't. |

None individually fatal; together they make this a **hard business, not an
open field.**

### A.6 Recommended sequencing (de-risked)

1. **Build it as the portfolio project exactly as spec'd.** Hiring value is
   independent of any market gap.
2. **Design as if it could be a product** — one-command install, good defaults,
   clean multi-tenancy-ready data model, the AI explanation layer. Low extra
   cost; keeps the door open; makes the "could this be a SaaS?" story credible
   in interviews.
3. **Ship open-source first.** Release the tool; see whether the
   "Falco-is-too-complex, this-is-lovely" reaction actually materializes from
   real users (homelab / indie / r/selfhosted communities are cheap to reach).
4. **Only then consider a hosted paid tier.** Let demand prove itself before
   committing. Open-core (free self-hosted agent + paid hosted dashboard /
   multi-host / retention / alerting integrations) is the natural model and
   mirrors how Plausible/Umami monetize.

**Net:** portfolio value now with zero downside, plus a real, evidence-based
*option* on the SaaS upside — without betting the project on an unproven market
gap.
