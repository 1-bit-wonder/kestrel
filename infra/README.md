# /infra — reproducible VM & provisioning

The safe place to load eBPF probes. The host has no C/eBPF toolchain by design
(`SPEC.md` §4) — that toolchain lives here, in a throwaway VM with its **own
kernel**. A privileged container is *not* a boundary; it shares the host kernel.

## Status

- **Built:** Nix flake (repo root `flake.nix` + `nix/vm.nix`) — a host devShell
  with the full toolchain and a one-command throwaway dev VM. This is the
  Phase 0 / Phase 4-infra unblocker for the Go agent.
- **Not yet built:** the `nixosTest` kernel-integration test (boot → load probe
  → trigger `execve` → assert the dashboard received it) and the
  Terraform/libvirt provisioning. Both land in Phase 4, after the agent exists.

```
/infra
  /nix
    vm.nix        # the dev-VM NixOS module (imported by the root flake)
  /terraform      # libvirt (dev VM) + VPS provisioning — TODO (Phase 4)
```

## The dev VM (`flake.nix` at the repo root)

```bash
# Host toolchain (compile is fine on the host; LOADING probes is VM-only):
nix develop                 # go, clang, llvm, bpftool, libbpf, node, pnpm

# The app runs on the HOST (it needs no kernel; native FS keeps Vite fast):
./kestrel dev               # → http://localhost:5173  (wraps `cd app && pnpm dev`)
./kestrel clean             # wipe the persisted dev DB so the feed starts empty

# The agent runs in the VM (it needs a real kernel). Boot the throwaway VM:
./kestrel vm                # = nix run .#vm (the agent auto-starts as a service)
#   KESTREL_SRC=/path/to/checkout nix run .#vm   # if not running from the repo root
ssh -p 2222 dev@localhost   # a real second terminal into the VM (password: dev)

# Inside the VM, the agent is a systemd service (auto-builds from ~/kestrel/agent
# on boot, runs as root). Watch / restart it:
journalctl -u kestrel-agent -f
sudo systemctl restart kestrel-agent        # rebuild + restart after probe edits
```

**The dev split:** the SvelteKit **app runs on the host**; only the **agent runs
in the VM**. The agent ships events *outbound* to the host app at
`http://10.0.2.2:5173/api/ingest` (`10.0.2.2` is the host from QEMU's network) —
no port-forward needed. We deliberately do **not** run the app over the 9p mount:
Vite reading `node_modules` over 9p is unusably slow (~14 s startup, SSR stalls),
and pnpm's symlink layout doesn't survive being written through 9p. Keep
`node_modules` host-native.

The VM is disposable: its root is a **tmpfs** (`diskImage = null`), so each
`nix run .#vm` boots fresh and all state is discarded on shutdown — a bad probe
costs a reboot, not your machine. Your source edits live on the host via the 9p
mount, so they survive.

### Why these choices

- **Nix flake, pinned `nixos-25.05`:** the kernel *is* the eBPF surface, so it's
  pinned and reproducible. That kernel is well past the ≥ 5.8 floor (`SPEC` §12)
  and ships `CONFIG_DEBUG_INFO_BTF=y`, so `/sys/kernel/btf/vmlinux` exists and
  CO-RE relocations resolve at load time — no per-kernel probe rebuilds.
- **devShell on the host:** compiling a probe (`bpf2go`, `go build`) is safe on
  the host; only *loading/attaching* one must happen in the VM (Golden Rule #1).
  The devShell unblocks agent codegen/build without booting the VM each time.
- **9p shared dir:** edit on the host with your normal tools; the agent builds
  and runs against the same tree inside the VM. No syncing, no rebuild-to-test.
  (Source only — `node_modules` stays host-native; see the dev-split note above.)

## Planned (Phase 4)

- **`nixosTest` (the differentiator):** declaratively boot a VM, load the probe,
  trigger an `execve`, assert the dashboard received the event — a kernel-level
  integration test runnable in CI. Almost no portfolio demonstrates this.
- **Terraform + `dmacvicar/libvirt`:** declare the dev VM in HCL; the same tool
  (different provider) provisions the prod VPS.
