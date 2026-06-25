# /agent — Go userspace agent + eBPF probes

> ⚠️ **Probes load in the dev VM only — never the host** (CLAUDE.md Golden
> Rule #1). A privileged container is *not* a safe boundary; it shares the host
> kernel. Use a VM with its own kernel. Compiling is safe anywhere.

Status: **Phase 1 — execve probe built.** Traces `sys_enter_execve`, ships
`exec` events to the app's ingest endpoint, which renders them in the live feed
([`/app`](../app)).

## Layout

```
/agent
  main.go              load probe, drain ring buffer, decode, enrich, ship
  bpf/
    exec.bpf.c         the execve probe (CO-RE; emits {pid,ppid,uid,comm,filename})
    headers/bpf/*.h    vendored libbpf program-side headers (self-contained build)
    vmlinux.h          generated from this kernel's BTF (gitignored)
  internal/ship/       batch + POST events to /api/ingest (matches the Zod schema)
  exec_bpfel.go, *.o   bpf2go output (gitignored — run `go generate`)
```

The event JSON the shipper sends is validated by the **single source of truth**
Zod contract at `app/src/lib/schema/event.ts`. Keep `internal/ship.Event` in
sync with it.

## Build & run

Everything except the last line is safe on the host (use `nix develop` for the
toolchain). **`sudo ./kestrel-agent` loads probes — VM only.**

```bash
go generate ./...     # 1) bpftool dumps vmlinux.h  2) bpf2go compiles C + gens bindings
go build -o kestrel-agent .
sudo ./kestrel-agent  # VM ONLY — attaches the tracepoint
```

The agent posts to `KESTREL_INGEST_URL` (default `http://10.0.2.2:5173/api/ingest`,
i.e. the host app as seen from inside the VM). Run the app on the host first
(`./kestrel dev` from the repo root), boot the VM (`./kestrel vm`), then
inside the VM build and run the agent — execs across the VM appear in the feed.

In the **dev VM it runs automatically** as a systemd service (`infra/nix/vm.nix`)
that builds from `~/kestrel/agent` on boot — no manual step. Watch it with
`journalctl -u kestrel-agent -f`; after editing the probe, `sudo systemctl
restart kestrel-agent` rebuilds and reloads. The manual commands above are for
host compile-checks and ad-hoc runs.

## Next (Phase 2)

ppid is already captured, so the process-tree cache + tree view (SPEC 8.2) build
on this. A `sched_process_exit` probe will let the agent track process lifetimes.
