# CLAUDE.md

Guidance for AI coding agents working in this repo. Read this fully before
making changes. The authoritative product/architecture document is `SPEC.md` —
this file is the operational companion to it.

---

## What this project is

**Kestrel** (working title) — a single-host Linux runtime-security &
observability tool. An eBPF agent traces kernel events (process exec, file
access, network connections) and streams them to a SvelteKit web app that
renders a live feed, process tree, network map, sensitive-file monitor, and a
rule-based alert engine.

It is the friendly UI layer that kernel-native tools (Falco etc.) deliberately
don't ship. See `SPEC.md` §1 for full positioning.

---

## Golden rules (read before anything else)

1. **NEVER load or test eBPF probes on the host machine.** All probe loading,
   attaching, and testing happens **inside the dev VM** (own kernel). A
   privileged container is NOT a safe boundary — it shares the host kernel. If
   a task would load a probe, confirm it runs in the VM. See `SPEC.md` §4.
2. **Respect the build order.** Must-haves first: live feed → process tree →
   host overview (`SPEC.md` §8.1, §8.2, §8.6), via the phases in `SPEC.md` §9.
   Do **not** jump ahead to stretch features (network map, alerts, LLM,
   enforcement, multi-host) until the core loop works end-to-end.
3. **Enforcement is out of scope for now.** The tool is **observe-only** in v1.
   Do not add process-killing / inline blocking. It's a far-stretch goal
   (`SPEC.md` §8.10) with a much higher risk bar.
4. **Each phase must end with something that runs.** Never leave the repo in an
   all-backend-no-frontend (or vice versa) half-state. Prefer a thin vertical
   slice that works over a thick horizontal layer that doesn't.
5. **Keep the data model multi-tenancy-ready.** Even though v1 is single-host,
   model events/rules/alerts as belonging to a host that belongs to an account.
   This preserves the SaaS option at near-zero cost (`SPEC.md` Appendix A.6).
   Do not hardcode single-host/single-user assumptions into the schema.

---

## Tech stack (do not substitute without asking)

| Layer | Choice |
|---|---|
| eBPF probes | C, compiled with clang/LLVM |
| Userspace agent | Go + **`github.com/cilium/ebpf`** (pure Go, `CGO_ENABLED=0`, `bpf2go` workflow). NOT libbpfgo. |
| Web app | SvelteKit, Svelte 5 **runes** (not legacy `$:`), TypeScript |
| Styling | Tailwind CSS |
| DB | Postgres (prod) / SQLite (dev ok), **Drizzle** ORM |
| Validation | Zod (+ sveltekit-superforms for forms) |
| Real-time | SSE (primary); WebSocket only if bi-directional control is needed |
| Charts/graph | D3 for process tree & network graph; lightweight chart lib for time-series |
| IaC | Nix (dev VM + `nixosTest`) + Terraform/libvirt (provisioning) |
| Tests | Vitest (unit), Playwright (e2e), NixOS `nixosTest` (kernel integration) |
| Deploy | VPS via Node adapter (agent must run on a real kernel) |

If a task seems to need a different library or approach, flag it and explain
why before swapping. Library choices are deliberate (see `SPEC.md` §3).

---

## Repository layout (target — create as needed)

```
/agent              Go userspace agent (cilium/ebpf)
  /bpf              eBPF C source (*.bpf.c) + bpf2go generated bindings
  /internal         decode, enrich, process-tree cache, shipper
  main.go
/app                SvelteKit application
  /src
    /lib            shared components, types, the agent↔app event schema (Zod)
    /routes         pages + +page.server.ts + +server.ts endpoints
    /lib/server     ingest, rule engine, SSE hub, db (drizzle)
  drizzle/          schema + migrations
/infra
  /nix              configuration.nix, VM definition, nixosTest
  /terraform        libvirt (dev VM) + VPS provisioning
/SPEC.md            authoritative product/architecture doc
/CLAUDE.md          this file
/README.md          narrative + architecture diagram (write alongside, SPEC §10)
```

The single source of truth for the **event schema** is the Zod schema in
`/app/src/lib` — the Go agent must produce events matching it. Keep them in
sync; treat the schema in `SPEC.md` §6 as the contract.

---

## Commands (fill in / verify as the repo materializes)

These are the intended commands; confirm they exist before relying on them.

```bash
# --- Quick start (repo-root dispatcher) ---
./kestrel dev           # start the app (frontend+backend) on the host → :5173
                        #   KESTREL_SYNTHETIC=1 ./kestrel dev   # demo data (opt-in)
./kestrel clean         # wipe the persisted dev DB (empty feed next run)
./kestrel vm            # boot the dev VM (the agent auto-starts inside it)

# --- App (run from /app) ---
pnpm install
pnpm dev                # SvelteKit dev server
pnpm build
pnpm test               # vitest
pnpm test:e2e           # playwright
pnpm check              # svelte-check / tsc
pnpm lint               # eslint + prettier

# --- DB ---
pnpm drizzle:generate   # generate migration from schema
pnpm drizzle:migrate    # apply migrations

# --- Agent (in the VM, it runs as a service that auto-builds on boot) ---
journalctl -u kestrel-agent -f  # watch the running agent
sudo systemctl restart kestrel-agent   # rebuild + restart after editing the probe
# Manual build (host `nix develop` or in the VM; loading is VM ONLY):
go generate ./...               # bpftool→vmlinux.h, then bpf2go compiles C (needs $BPF_CLANG)
CGO_ENABLED=0 go build -o kestrel-agent .
sudo ./kestrel-agent            # loads probes — VM ONLY; KESTREL_INGEST_URL overrides target

# --- Infra (Nix flake at repo root) ---
nix develop             # host devShell: go, clang, llvm, bpftool, libbpf, node, pnpm
nix run .#vm            # boot the throwaway dev VM (repo mounted at ~/kestrel via 9p)
                        #   KESTREL_SRC=/path nix run .#vm   # if not run from the repo root
nix flake check         # eval the flake (+ nixosTest once it exists — Phase 4)
terraform -chdir=infra/terraform plan   # TODO (Phase 4)
```

When you add a real command, update this section so it stays accurate.

---

## Coding conventions

- **TypeScript everywhere in `/app`.** No untyped JS. Prefer types inferred
  from Drizzle and Zod over hand-written duplicates.
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`) — not the
  Svelte 4 reactive-label style.
- **Validate at the boundary.** Every event entering the ingest endpoint is
  Zod-parsed before touching the DB or the rule engine.
- **Server logic stays in `/lib/server`** and `+page.server.ts` / `+server.ts`.
  Never import server-only modules into client components.
- **Go:** standard `gofmt`/`go vet` clean; keep eBPF C minimal and well
  commented (the verifier is strict — no unbounded loops, no arbitrary pointer
  deref). Use CO-RE/BTF for portability.
- **Small, reviewable commits**, one concern each. Conventional-commit style
  messages (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- **Tests with behavior.** New rule-engine logic and event decoding get unit
  tests. Don't add features to the dashboard without at least a smoke e2e. The
  rule engine + event schema additionally get **property-based tests**
  (`fast-check`) asserting invariants (no false match, deterministic verdicts,
  malformed events rejected); the ingest→hub→SSE path gets sequence-number
  gap/dup checks. See the three-tier strategy in `SPEC.md` §7 (tier 1, the eBPF
  verifier, is free — §6).

---

## How to work a task

1. **Locate it in `SPEC.md`.** Identify which phase (§9) and view (§8) it
   belongs to. If it's a stretch feature and the must-haves aren't done, stop
   and flag it.
2. **Check the safety rules** above — especially anything that loads a probe.
3. **Plan the vertical slice.** What's the smallest end-to-end change that
   leaves the repo runnable?
4. **Keep the event schema in sync** if the change touches agent↔app data.
5. **Write/adjust tests.**
6. **Run** `pnpm check`, `pnpm test`, and (if agent code) `go test` before
   declaring done. Note what you could not verify (e.g. anything needing the VM
   if you're not in it).
7. **Update docs** (`CLAUDE.md` commands, `README.md`, or `SPEC.md`) if the
   change affects them.

---

## Things to flag rather than silently do

- Swapping any stack choice in the table above.
- Anything that would run probe code outside the VM.
- Adding enforcement / process-killing behavior.
- Introducing browser storage (`localStorage` etc.) in the app — use server +
  DB or in-memory state.
- Schema changes that bake in single-host/single-user assumptions.
- Pulling in a heavy new dependency when a light one or the stdlib would do.

---

## Current status

> Update this section as the project progresses so the agent always knows where
> things stand.

- **Phase:** 2 **DONE & pushed** — must-haves complete and **verified live in the
  VM** end-to-end (real execs/exits drive overview + feed + process tree; agent
  loads both probes + ships a `/proc` startup snapshot). **Phase 3 is next**
  (security credibility — see TODO).
- **Working:** The SvelteKit app runs end-to-end with all three must-have views.
  `/app` has the Zod event schema (the agent↔app contract,
  `src/lib/schema/event.ts`, now incl. an `exit` lifecycle type), a Drizzle
  schema (accounts→hosts→events/rules/alerts, multi-tenancy-ready), the
  Zod-validated ingest endpoint (`POST /api/ingest`), and an SSE live hub
  (`GET /api/stream`). Views (nav: Overview / Live feed / Processes):
  - **Live feed (8.1)** at `/feed` — the original real-time table.
  - **Host overview (8.6)** at `/` (landing) — events/sec, active processes,
    connection count, alerts-last-hour, an event-rate sparkline, by-type
    breakdown, and busiest processes. Pure compute in `src/lib/overview.ts`
    (`computeOverview`, unit-tested); live via a client-side rolling buffer +
    SSE that recomputes with the *same* pure function (single source of truth).
  - **Process tree (8.2)** at `/processes` — parent→child forest **derived from
    the event stream** (not an agent snapshot; SPEC §7 allows an app-side
    `processes` view) in `src/lib/processTree.ts` (`buildProcessTree`,
    unit-tested), laid out with **d3-hierarchy** and rendered as SVG by Svelte
    (D3 = layout math, Svelte = DOM). Click a node → drill-down (status,
    lifetime, user, ppid, children, activity counts). `exit` events give
    liveness (running vs exited) and lifetimes.
  The synthetic generator (`src/lib/server/synthetic.ts`) now maintains a
  **coherent live process set** (children spawned from live parents, activity,
  and exits) so the tree and overview have real structure — still **opt-in** via
  `KESTREL_SYNTHETIC=1`. Verified: `pnpm check` (0/0), `pnpm test` (24 pass),
  `pnpm lint`, `pnpm build`, and a manual SSR smoke test of all three routes
  with synthetic data. Tests force an in-memory PGlite via `test.env` in
  `vite.config.ts` so they never touch the on-disk dev DB.
- **DB note:** dev/test uses **PGlite** (WASM Postgres), not SQLite — the host
  has no C compiler (toolchain lives in the VM) so the native `better-sqlite3`
  driver can't build here. PGlite needs no native build and gives real Postgres
  dialect parity with prod. Drizzle calls are async as a result.
- **Infra note:** root `flake.nix` + `infra/nix/vm.nix` give a host `nix develop`
  toolchain and a one-command throwaway dev VM (`nix run .#vm`, tmpfs root via
  `diskImage = null`) — pinned `nixos-25.05` (kernel ≫ 5.8, BTF on for CO-RE),
  repo mounted at `~/kestrel` over 9p, SSH on host `2222`. Verified by `nix flake
  check` (full eval, no full build — that compiles a kernel+QEMU). Compiling
  probes on the host is fine; **loading** them is VM-only (Golden Rule #1).
- **Dev split (important):** the SvelteKit **app runs on the HOST** (`cd app &&
  pnpm dev` → localhost:5173); only the **agent runs in the VM**. Do NOT run the
  app over 9p — Vite reading `node_modules` over 9p is unusably slow and pnpm's
  symlink layout corrupts across the 9p boundary. `node_modules` stays
  host-native. The agent ships events *outbound* to the host app at
  `http://10.0.2.2:5173/api/ingest` (`10.0.2.2` = host from the VM).
- **Agent (Phase 2, compile-verified):** `bpf/exec.bpf.c` now carries **two
  programs sharing one ring buffer**, discriminated by a `kind` field on the
  event struct: `sys_enter_execve` (EVENT_EXEC: pid/ppid/uid/comm/filename) and
  `sched_process_exit` (EVENT_EXIT: pid/ppid/uid/comm; emitted only for the
  thread-group leader so it's one exit per process, not per thread). `main.go`
  attaches both tracepoints and maps `kind`→`"exec"`/`"exit"` for the shipper
  (`internal/ship`, JSON matches the Zod contract). Verified on the host in
  `nix develop`: `go generate` (bpftool vmlinux.h + bpf2go/clang), `go build`,
  `go vet`, `gofmt` all clean. **Not yet run** — the verifier accepting the
  programs + the live VM→host flow are VM-only (Golden Rule #1). bpf2go uses the
  UNWRAPPED clang via `$BPF_CLANG`. Generated files (`*_bpf*.go/.o`,
  `bpf/vmlinux.h`) are gitignored — run `go generate` to (re)create them.
- **Agent /proc snapshot (`internal/procscan`, compile+unit-verified):** at
  startup the agent walks `/proc` and ships every live **userspace** process as
  an `exec` event (pid/ppid/comm/exe/cmdline; kernel threads skipped). Without
  this the execve probe only ever sees processes that exec *after* it attaches,
  so pre-existing ancestry (systemd → … → your shell) is missing and live execs
  render as disconnected roots — the process tree looked flat. The stat parser
  is unit-tested (`procscan_test.go`); the live `/proc` read is host-safe (not
  BPF). One-shot, so it's a small burst in the feed at agent start.
- **UI label fix:** at `sys_enter_execve` the kernel `comm` is still the
  *caller* (the spawning shell), not the new program; the real binary is in
  `exe`. The tree/overview now label processes by `procName(e)` (exe basename,
  falling back to comm) so `nano` shows as `nano`, not `bash`. The event-rate
  sparkline is now a full-width (`width=100%`) bar histogram over a 60s/1s,
  wall-clock-aligned window (was a 5min/30-bucket line that crawled and whose
  fixed pixel width left the panel ¾ empty).
- **Ingest perf + port pinning:** `lastSeen` host bumps are throttled
  fire-and-forget and host ids resolved once per batch (was an awaited UPDATE
  per event — the dashboard-lag cause). Vite is pinned to `strictPort: 5173` so
  it fails loudly instead of silently bumping to 5174 and orphaning the agent's
  hardcoded `10.0.2.2:5173` target.
- **Next — Phase 3 (security credibility):** file-open + connect probes, network
  map (8.3), file monitor (8.4), rule engine + alerts (8.5) — the `alerts` card
  on the overview is wired to read 0 until then. Also in Phase 3+: the
  **server-side process-tree cache** (SPEC §6) — replace today's window-derived
  tree with a stateful cache updated at ingest; `buildProcessTree` stays the
  canonical batch builder the cache must match. **Do not start the cache until
  the new probes land.** Testing additions land here too: property-based tests
  (`fast-check`) for the rule engine + schema, and event-delivery checks (seq
  numbers + gap/dup detector + ingest-flood test) — see `SPEC.md` §7.
- **Known gaps / TODO:** `infra/terraform` + the `nixosTest` integration test are
  Phase 4; no rule engine yet (8.5, overview alerts hardcoded 0); **no Playwright
  e2e yet** (deferred — browser install in the sandbox is unverified; unit
  coverage carried Phase 2 instead); no agent decode unit tests yet (only
  `procscan`); the process tree derives from a recent event slice (no pruning of
  very old execs — the cache above is the fix); `pnpm dev` persists to
  `./kestrel-pgdata` (gitignored).
