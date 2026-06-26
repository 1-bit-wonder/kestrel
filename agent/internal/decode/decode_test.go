package decode

import "testing"

func TestPort(t *testing.T) {
	// 443 in network order is 0x01BB; the ring decodes those bytes little-endian
	// to 0xBB01 (47873), and Port must swap it back to 443.
	if got := Port(0xBB01); got != 443 {
		t.Errorf("Port(0xBB01) = %d, want 443", got)
	}
	if got := Port(0x3500); got != 53 { // 53 = 0x0035 network → 0x3500 decoded
		t.Errorf("Port(0x3500) = %d, want 53", got)
	}
}

func TestProto(t *testing.T) {
	cases := map[uint8]string{6: "tcp", 17: "udp", 0: "", 1: "", 132: ""}
	for in, want := range cases {
		if got := Proto(in); got != want {
			t.Errorf("Proto(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestFormatIP(t *testing.T) {
	v4 := [4]byte{1, 1, 1, 1}
	if got := FormatIP(afInet, v4, [16]byte{}); got != "1.1.1.1" {
		t.Errorf("FormatIP v4 = %q, want 1.1.1.1", got)
	}

	// 2001:db8::1
	v6 := [16]byte{0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}
	if got := FormatIP(afInet6, [4]byte{}, v6); got != "2001:db8::1" {
		t.Errorf("FormatIP v6 = %q, want 2001:db8::1", got)
	}

	if got := FormatIP(99, v4, v6); got != "" {
		t.Errorf("FormatIP unknown family = %q, want empty", got)
	}
}

func TestFileOpenFlags(t *testing.T) {
	cases := []struct {
		flags int32
		want  string
	}{
		{0x0, "O_RDONLY"},
		{0x1, "O_WRONLY"},
		{0x2, "O_RDWR"},
		{0x2 | 0x40, "O_RDWR|O_CREAT"}, // O_RDWR|O_CREAT
		{0x1 | 0x40 | 0x200 | 0x400, "O_WRONLY|O_CREAT|O_TRUNC|O_APPEND"},
		{0x0 | 0x80000, "O_RDONLY|O_CLOEXEC"},
	}
	for _, c := range cases {
		if got := FileOpenFlags(c.flags); got != c.want {
			t.Errorf("FileOpenFlags(0x%x) = %q, want %q", c.flags, got, c.want)
		}
	}
}

func TestWatched(t *testing.T) {
	watched := []string{
		"/etc/shadow",
		"/etc/ssh/sshd_config",
		"/root/.ssh/authorized_keys",
		"/home/ni/.ssh/id_ed25519",
		"/tmp/.x",
		"/dev/shm/payload",
		"/var/log/auth.log",
	}
	for _, p := range watched {
		if !Watched(p) {
			t.Errorf("Watched(%q) = false, want true", p)
		}
	}

	ignored := []string{
		"/usr/lib/libc.so.6",
		"/etc/passwd", // deliberately omitted from the watch list (too noisy)
		"/proc/self/maps",
		"relative/path",
		"",
	}
	for _, p := range ignored {
		if Watched(p) {
			t.Errorf("Watched(%q) = true, want false", p)
		}
	}
}
