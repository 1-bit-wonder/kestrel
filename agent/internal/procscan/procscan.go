// Package procscan enumerates currently-running processes from /proc so the
// dashboard's process tree (SPEC §8.2) has the pre-existing ancestry that the
// execve probe cannot supply.
//
// Why this exists: the execve tracepoint only fires for processes that exec
// AFTER the agent attaches. Everything already running when the agent starts —
// systemd, sshd, the login shell, the agent's own ancestors — was never seen,
// so live execs (e.g. `ls` under your shell) have no parent node and render as
// disconnected roots. A one-shot /proc snapshot at startup seeds those existing
// processes so subsequent execs/exits attach to a real tree.
//
// Each live userspace process is emitted as an `exec` event carrying its
// pid/ppid/comm/exe/cmdline. Kernel threads (no /proc/<pid>/exe) are skipped —
// they're noise for a process/security view and would swamp the tree.
package procscan

import (
	"os"
	"strconv"
	"strings"
	"syscall"

	"kestrel/agent/internal/ship"
)

// Snapshot reads /proc and returns one `exec` event per live userspace process.
// Best-effort: unreadable or vanished processes are skipped, never fatal (the
// proc table races us constantly). Host/User/ts are filled by the caller/server.
func Snapshot() []ship.Event {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	out := make([]ship.Event, 0, len(entries))
	for _, ent := range entries {
		pid, err := strconv.ParseUint(ent.Name(), 10, 32)
		if err != nil {
			continue // non-numeric entry (/proc/self, /proc/stat, …)
		}
		base := "/proc/" + ent.Name()

		// No exe link ⇒ kernel thread (or already gone). Skip — also our cheapest
		// liveness check.
		exe, err := os.Readlink(base + "/exe")
		if err != nil || exe == "" {
			continue
		}

		stat, err := os.ReadFile(base + "/stat")
		if err != nil {
			continue // process exited between ReadDir and now
		}
		comm, ppid, ok := parseStat(string(stat))
		if !ok {
			continue
		}

		out = append(out, ship.Event{
			Type:    "exec",
			PID:     uint32(pid),
			PPID:    ppid,
			UID:     ownerUID(base),
			Comm:    comm,
			Exe:     exe,
			Cmdline: readCmdline(base),
		})
	}
	return out
}

// parseStat extracts comm and ppid from the contents of /proc/<pid>/stat.
//
// Format: "<pid> (<comm>) <state> <ppid> <pgrp> …". comm is delimited by
// parentheses and may itself contain spaces or ')', so we slice on the FIRST
// '(' and the LAST ')' rather than splitting on whitespace.
func parseStat(s string) (comm string, ppid uint32, ok bool) {
	open := strings.IndexByte(s, '(')
	close := strings.LastIndexByte(s, ')')
	if open < 0 || close < 0 || close < open {
		return "", 0, false
	}
	comm = s[open+1 : close]

	// Fields after ") ": [0]=state, [1]=ppid, …
	rest := strings.Fields(s[close+1:])
	if len(rest) < 2 {
		return "", 0, false
	}
	p, err := strconv.ParseUint(rest[1], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return comm, uint32(p), true
}

// ownerUID is the real uid of the process — the owner of its /proc/<pid> dir.
func ownerUID(base string) uint32 {
	fi, err := os.Stat(base)
	if err != nil {
		return 0
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Uid
	}
	return 0
}

// readCmdline returns the process's argv as a space-joined string. The kernel
// stores it NUL-separated with a trailing NUL; empty for kernel threads/zombies.
func readCmdline(base string) string {
	raw, err := os.ReadFile(base + "/cmdline")
	if err != nil || len(raw) == 0 {
		return ""
	}
	return strings.TrimSpace(strings.ReplaceAll(string(raw), "\x00", " "))
}
