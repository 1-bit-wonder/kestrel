// Package decode turns the raw fields of a kernel `struct event` into the
// userspace-friendly shapes the ingest endpoint expects (SPEC §6 contract):
// open-flag bitmasks → human strings, network-order addresses/ports → text, and
// the sensitive-path watch list that gates which file_open events ship.
//
// These are pure functions so the agent's decode layer is unit-testable without
// a kernel (the agent itself can only run in the VM — CLAUDE.md Golden Rule #1).
package decode

import (
	"math/bits"
	"net"
	"strings"
)

// Address families, mirroring AF_INET / AF_INET6 in exec.bpf.c.
const (
	afInet  = 2
	afInet6 = 10
)

// L4 protocol numbers (IPPROTO_*), as read from sk_protocol in the probe.
const (
	protoTCP = 6
	protoUDP = 17
)

// Port converts a network-byte-order port (as the probe read it, decoded from
// the ring sample as a native-endian uint16) into host order. The ring sample
// is little-endian on our targets, so a byte swap recovers the real port.
func Port(networkOrder uint16) uint16 {
	return bits.ReverseBytes16(networkOrder)
}

// Proto maps an IPPROTO_* number to the schema's protocol string ("tcp"/"udp").
// Anything else returns "" — the agent treats that as a non-shippable event.
func Proto(p uint8) string {
	switch p {
	case protoTCP:
		return "tcp"
	case protoUDP:
		return "udp"
	default:
		return ""
	}
}

// FormatIP renders the destination address for a net_connect event. The probe
// fills daddr4 for AF_INET and daddr6 for AF_INET6, both in network order; both
// net.IP slices stringify directly. Returns "" for an unexpected family.
func FormatIP(family uint16, v4 [4]byte, v6 [16]byte) string {
	switch family {
	case afInet:
		return net.IP(v4[:]).String()
	case afInet6:
		return net.IP(v6[:]).String()
	default:
		return ""
	}
}

// open(2) flag bits we surface. Values are the standard Linux x86 constants
// (also stable across the arches we target); kept local so decode has no cgo or
// syscall dependency and stays trivially testable.
const (
	oAccMode   = 0x3
	oRdOnly    = 0x0
	oWrOnly    = 0x1
	oRdWr      = 0x2
	oCreat     = 0x40
	oTrunc     = 0x200
	oAppend    = 0x400
	oNonBlock  = 0x800
	oDirectory = 0x10000
	oCloexec   = 0x80000
)

var flagBits = []struct {
	bit  int32
	name string
}{
	{oCreat, "O_CREAT"},
	{oTrunc, "O_TRUNC"},
	{oAppend, "O_APPEND"},
	{oNonBlock, "O_NONBLOCK"},
	{oDirectory, "O_DIRECTORY"},
	{oCloexec, "O_CLOEXEC"},
}

// FileOpenFlags renders raw open(2) flags as a "|"-joined string, e.g.
// "O_RDWR|O_CREAT". The low two bits are the access mode (always present); the
// rest are appended in a stable order so the output is deterministic.
func FileOpenFlags(flags int32) string {
	var parts []string
	switch flags & oAccMode {
	case oWrOnly:
		parts = append(parts, "O_WRONLY")
	case oRdWr:
		parts = append(parts, "O_RDWR")
	default: // O_RDONLY is 0; an out-of-range accmode (3) also reads as read.
		_ = oRdOnly
		parts = append(parts, "O_RDONLY")
	}
	for _, f := range flagBits {
		if flags&f.bit != 0 {
			parts = append(parts, f.name)
		}
	}
	return strings.Join(parts, "|")
}

// watchPrefixes is the sensitive-path policy for the file monitor (SPEC §8.4):
// only file_open events whose path starts with one of these ship, so the probe's
// firehose of every openat doesn't swamp the feed. Editable here in userspace.
// Tunable; deliberately curated to stay high-signal (e.g. /etc/passwd is omitted
// as it's read constantly by name resolution).
var watchPrefixes = []string{
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers",
	"/etc/ssh/",
	"/root/",
	"/home/",
	"/tmp/",
	"/dev/shm/",
	"/var/log/auth",
}

// Watched reports whether a file path is sensitive enough to ship. Paths are the
// NUL-trimmed strings read from the probe; relative paths (no leading "/") never
// match, which is intended — the watch list is anchored at absolute roots.
func Watched(path string) bool {
	for _, p := range watchPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}
