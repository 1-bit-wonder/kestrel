These are the program-side headers from libbpf 1.7.0 (nixpkgs), vendored so
the eBPF C compiles with a self-contained `-I bpf/headers` and no dependency
on where libbpf lives on the host vs. the VM. Regenerate by copying from
`$(nix eval --raw nixpkgs#libbpf)/include/bpf/`.
