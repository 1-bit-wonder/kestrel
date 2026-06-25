# The Kestrel dev VM — a throwaway QEMU/KVM guest with its OWN kernel.
#
# This is the ONLY safe place to load eBPF probes (CLAUDE.md Golden Rule #1 /
# SPEC §4): a privileged container shares the host kernel and is NOT a boundary.
# Boot it, then build + run the agent inside it; the host kernel is never
# touched. Nothing here persists — `nix run .#vm` gives a fresh disk each time.
{ config, pkgs, lib, modulesPath, ... }:
{
  # `system.build.vm` (the runnable QEMU wrapper) comes from this module. When
  # you use `nixos-rebuild build-vm` it's added implicitly; building the VM
  # straight from a flake's nixosConfiguration, we import it ourselves.
  imports = [ (modulesPath + "/virtualisation/qemu-vm.nix") ];

  networking.hostName = "kestrel-dev"; # → launcher script run-kestrel-dev-vm

  # --- Throwaway-VM ergonomics: passwordless dev user, autologin -------------
  users.users.dev = {
    isNormalUser = true;
    extraGroups = [ "wheel" ]; # sudo (probes need root)
    password = "dev"; # throwaway VM — convenience over secrecy
  };
  security.sudo.wheelNeedsPassword = false; # `sudo ./agent` without a prompt
  services.getty.autologinUser = "dev";

  # A real second terminal from the host: `ssh -p 2222 dev@localhost` (pw: dev).
  # Throwaway VM on a host-only forward, so password auth is acceptable here.
  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = true;
    settings.PermitRootLogin = "no";
  };

  # bpf2go compiles the probe with the UNWRAPPED clang (the Nix cc-wrapper
  # injects host hardening flags clang rejects for the bpfel target). The agent's
  # //go:generate references this as `-cc $BPF_CLANG`.
  environment.sessionVariables.BPF_CLANG = "${pkgs.llvmPackages.clang-unwrapped}/bin/clang";

  # --- Toolchain available INSIDE the VM --------------------------------------
  # Mirrors the flake's host devShell, plus the bpftrace on-ramp (SPEC §4.5) for
  # proving the kernel layer end-to-end before the compiled agent exists.
  environment.systemPackages = with pkgs; [
    # eBPF / agent build + run
    go
    clang
    llvm
    bpftools
    libbpf
    elfutils
    zlib
    # bpftrace-first on-ramp:
    #   sudo bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%s %d -> %s\n", comm, pid, str(args->filename)); }'
    bpftrace
    # app
    nodejs_22
    pnpm
    # misc
    git
    gnumake
  ];

  # --- Kernel / eBPF prerequisites -------------------------------------------
  # The nixos-25.05 default kernel is well past the >= 5.8 floor and is built
  # with CONFIG_DEBUG_INFO_BTF=y, so /sys/kernel/btf/vmlinux exists and CO-RE
  # relocations resolve at load time (SPEC §6 CO-RE, §12). No extra config
  # needed; pinned here as the documented contract.
  boot.kernelPackages = lib.mkDefault pkgs.linuxPackages;

  # --- Host ↔ VM wiring -------------------------------------------------------
  virtualisation = {
    memorySize = 4096; # MB
    cores = 4;
    diskSize = 8192; # MB — room for node_modules + go build cache

    # Truly throwaway: tmpfs root, no persistent qcow2 littering the repo. Each
    # `nix run .#vm` is a fresh disk — a bad probe costs a reboot, not state.
    diskImage = null;

    # Edit on the host, build/run in the VM: mount the working tree over 9p.
    # $KESTREL_SRC overrides the source; default is wherever you `nix run` from
    # (the repo root in normal use). Escaped so the shell — not Nix — expands it.
    sharedDirectories.kestrel = {
      source = "\${KESTREL_SRC:-\$PWD}";
      target = "/home/dev/kestrel";
    };

    # SSH for a real second terminal from the host. NOTE: we deliberately do
    # NOT forward 5173/3000 — the app runs on the HOST (not here), so forwarding
    # them would clash with the host's own dev server on those ports. The agent
    # reaches the host app *outbound* at http://10.0.2.2:5173 (QEMU's gateway),
    # which needs no forward.
    forwardPorts = [
      { from = "host"; host.port = 2222; guest.port = 22; } # ssh -p 2222 dev@localhost
    ];
  };

  # Graphical window is unnecessary — serial console is enough for a dev VM and
  # keeps `nix run .#vm` headless-friendly.
  virtualisation.graphics = false;

  # --- Agent as a managed service --------------------------------------------
  # Builds the agent from the mounted source and runs it on boot — no manual
  # `sudo ./kestrel-agent`. Watch it: `journalctl -u kestrel-agent -f`. It builds
  # into the VM's tmpfs (NOT back over 9p) so generated files never touch the
  # host tree. Heavy-ish first boot (go mod download + clang); if you'd rather
  # drive it by hand: `sudo systemctl disable --now kestrel-agent`.
  systemd.services.kestrel-agent = {
    description = "Kestrel eBPF agent (execve tracer)";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    path = with pkgs; [ go bpftools bash coreutils llvm ]; # llvm → llvm-strip (bpf2go strips the .o)
    environment = {
      BPF_CLANG = "${pkgs.llvmPackages.clang-unwrapped}/bin/clang";
      KESTREL_INGEST_URL = "http://10.0.2.2:5173/api/ingest";
      HOME = "/root";
      GOTOOLCHAIN = "local"; # use the installed go; never fetch a toolchain
      GOCACHE = "/tmp/kestrel-go/cache";
      GOMODCACHE = "/tmp/kestrel-go/mod";
      CGO_ENABLED = "0";
    };
    serviceConfig = {
      Type = "exec";
      RequiresMountsFor = "/home/dev/kestrel"; # wait for the 9p source mount
      # Build a fresh copy in tmpfs so `go generate` never writes over 9p.
      ExecStartPre = "${pkgs.writeShellScript "kestrel-agent-build" ''
        set -euo pipefail
        rm -rf /tmp/kestrel-agent-build
        cp -a /home/dev/kestrel/agent /tmp/kestrel-agent-build
        cd /tmp/kestrel-agent-build
        go generate ./...
        go build -o /tmp/kestrel-agent .
      ''}";
      ExecStart = "/tmp/kestrel-agent";
      Restart = "on-failure"; # ride out a not-yet-ready network on first boot
      RestartSec = 5;
      TimeoutStartSec = 600; # first build downloads modules + compiles
    };
  };

  # First-boot login banner so the workflow is discoverable from the console.
  users.motd = ''
    Kestrel dev VM — this is for the eBPF AGENT, which needs a real kernel.
    The repo is mounted at ~/kestrel.

      Agent:   runs automatically as a service →  journalctl -u kestrel-agent -f
               (rebuild/restart after edits: sudo systemctl restart kestrel-agent)
      On-ramp: sudo bpftrace -e 'tracepoint:syscalls:sys_enter_execve \
                 { printf("%s %d -> %s\n", comm, pid, str(args->filename)); }'

    Run the SvelteKit APP on the HOST, not here (it needs no kernel and 9p is
    slow for Vite):  ./kestrel dev   →  http://localhost:5173
    The agent ships events to the host app at  http://10.0.2.2:5173/api/ingest
    (10.0.2.2 = the host, as seen from this VM).

    Probes load here safely (this VM has its own kernel). Never on the host.
  '';

  system.stateVersion = "25.05";
}
