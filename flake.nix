{
  description =
    "Kestrel — single-host eBPF runtime-security & observability dashboard. Dev toolchain + throwaway QEMU dev VM (the safe place to load probes).";

  # Pinned to a stable NixOS release: the kernel is the eBPF surface, so we want
  # it reproducible. nixos-25.05's default kernel is well past the >= 5.8 floor
  # (SPEC §12) and ships CONFIG_DEBUG_INFO_BTF=y, so CO-RE works out of the box.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      # The full build toolchain. Shared between the host devShell (compile is
      # fine on the host — only LOADING a probe is VM-only, Golden Rule #1) and
      # the in-VM environment (vm.nix imports this same list).
      toolchain = with pkgs; [
        # eBPF / agent
        go
        clang
        llvm
        bpftools # provides `bpftool` (BTF dump for vmlinux.h, map inspection)
        libbpf # bpf_helpers.h, bpf_core_read.h, … (include path for bpf2go)
        elfutils # libelf — cilium/ebpf object loading
        zlib
        # app
        nodejs_22
        pnpm
      ];
    in
    {
      # `nix develop` — toolchain on the host. You CAN `go generate` / `go build`
      # / `pnpm` here; you CANNOT `sudo ./agent` here (loads probes → VM only).
      devShells.${system}.default = pkgs.mkShell {
        packages = toolchain;
        # libbpf headers live under $dev/include; expose for bpf2go's clang `-I`.
        BPF_HEADERS = "${pkgs.libbpf}/include";
        shellHook = ''
          echo "▸ Kestrel devShell — go $(go version | cut -d' ' -f3), node $(node -v), pnpm $(pnpm -v)"
          echo "  Compiling probes here is fine. LOADING them is VM-only (CLAUDE.md Golden Rule #1):"
          echo "    nix run .#vm     # boot the throwaway dev VM, then build+run the agent inside it"
        '';
      };

      # The throwaway dev VM. Build/boot with either:
      #   nixos-rebuild build-vm --flake .#kestrel-vm   (then ./result/bin/run-*-vm)
      #   nix run .#vm                                   (convenience wrapper)
      nixosConfigurations.kestrel-vm = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ ./infra/nix/vm.nix ];
      };

      # `nix build .#vm` → ./result/bin/run-kestrel-dev-vm
      packages.${system}.vm =
        self.nixosConfigurations.kestrel-vm.config.system.build.vm;

      # `nix run .#vm` — boots the VM. Mounts $KESTREL_SRC (default: the dir you
      # invoke from) at /home/dev/kestrel so you edit on the host and build/run
      # inside the VM.
      #
      # The wrapper captures $PWD into KESTREL_SRC *before* exec'ing the upstream
      # launcher, because that launcher `cd`s into a scratch TMPDIR before the
      # 9p `-virtfs path=` is expanded — so a bare `$PWD` there would export the
      # VM's scratch dir instead of your repo. KESTREL_SRC set explicitly wins.
      apps.${system} =
        let
          runner = self.nixosConfigurations.kestrel-vm.config.system.build.vm;
          vmWrapper = pkgs.writeShellScript "kestrel-vm" ''
            export KESTREL_SRC="''${KESTREL_SRC:-$PWD}"
            exec ${runner}/bin/run-kestrel-dev-vm "$@"
          '';
          vmApp = {
            type = "app";
            program = "${vmWrapper}";
          };
        in
        {
          vm = vmApp;
          default = vmApp;
        };
    };
}
