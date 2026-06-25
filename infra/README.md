# /infra — reproducible VM & provisioning

Status: **not yet built** (Phase 4). Treat infra as a phase added *after* the
core agent→dashboard loop works — don't yak-shave provisioning first
(`SPEC.md` §5).

```
/infra
  /nix          configuration.nix, dev-VM definition, nixosTest
  /terraform    libvirt (dev VM) + VPS provisioning
```

## Plan

- **Nix / NixOS (primary):** `configuration.nix` pins the kernel and declares
  the full eBPF toolchain + agent + app. `nixos-rebuild build-vm` produces a
  throwaway QEMU VM in one command — the safe place to load probes.
- **`nixosTest` (the differentiator):** boot a VM, load the probe, trigger an
  `execve`, assert the dashboard received the event — an integration test for
  kernel-level code, runnable in CI.
- **Terraform + `dmacvicar/libvirt`:** declare the dev VM in HCL; the same tool
  (different provider) provisions the prod VPS.

> The host this repo is developed on has no C/eBPF toolchain by design — that
> toolchain belongs here, inside the VM.
