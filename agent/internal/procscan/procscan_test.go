package procscan

import "testing"

func TestParseStat(t *testing.T) {
	tests := []struct {
		name     string
		in       string
		wantComm string
		wantPpid uint32
		wantOK   bool
	}{
		{
			name:     "simple",
			in:       "1234 (bash) S 1 1234 1234 0 -1 4194304 1 0",
			wantComm: "bash",
			wantPpid: 1,
			wantOK:   true,
		},
		{
			name:     "comm with spaces and parens",
			in:       "42 (Web Content (1)) S 1795 42 42 0",
			wantComm: "Web Content (1)",
			wantPpid: 1795,
			wantOK:   true,
		},
		{
			name:     "kthread style comm",
			in:       "7 (kworker/0:0H-events) I 2 0 0 0",
			wantComm: "kworker/0:0H-events",
			wantPpid: 2,
			wantOK:   true,
		},
		{name: "no parens", in: "garbage without parens", wantOK: false},
		{name: "missing fields", in: "1 (init)", wantOK: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			comm, ppid, ok := parseStat(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if comm != tc.wantComm {
				t.Errorf("comm = %q, want %q", comm, tc.wantComm)
			}
			if ppid != tc.wantPpid {
				t.Errorf("ppid = %d, want %d", ppid, tc.wantPpid)
			}
		})
	}
}

// Snapshot must run against the live /proc without panicking and find at least
// the test process itself (a userspace process with an exe).
func TestSnapshotFindsSelf(t *testing.T) {
	got := Snapshot()
	if len(got) == 0 {
		t.Fatal("Snapshot returned no processes; expected at least this test binary")
	}
	for _, e := range got {
		if e.Type != "exec" {
			t.Errorf("event type = %q, want exec", e.Type)
		}
		if e.Comm == "" || e.Exe == "" {
			t.Errorf("process %d missing comm/exe: %+v", e.PID, e)
		}
	}
}
