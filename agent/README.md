# /agent — Go userspace agent + eBPF probes

> ⚠️ **Probes load in the dev VM only — never the host** (CLAUDE.md Golden
> Rule #1). A privileged container is *not* a safe boundary; it shares the host
> kernel. Use a VM with its own kernel.

Status: **not yet built** (Phase 1 completion). The app side it ships events to
already exists in [`/app`](../app).

## Planned layout (SPEC §6)

```
/agent
  /bpf          eBPF C source (*.bpf.c) + bpf2go generated bindings
  /internal     decode, enrich, process-tree cache, shipper
  main.go
```

## Plan

1. C `execve` probe → `BPF_MAP_TYPE_RINGBUF` ring buffer.
2. `bpf2go` compiles the C and generates typed Go loader bindings.
3. Go agent (`github.com/cilium/ebpf`, `CGO_ENABLED=0`): load objects, attach
   via the `link` subpackage, read the ring buffer, decode events.
4. Enrich (PID→metadata, user, cmdline, container id) and maintain a
   process-tree cache from exec/exit.
5. Batch and `POST /api/ingest` on the app — JSON matching the **single source
   of truth** Zod contract at `app/src/lib/schema/event.ts`.

Build/run (inside the VM):

```bash
go generate ./...   # bpf2go: compile C + gen bindings
go build ./...
go test ./...
sudo ./agent        # loads probes — VM ONLY
```
