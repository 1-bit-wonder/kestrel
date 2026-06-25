// Package ship batches decoded kernel events and POSTs them to the SvelteKit
// ingest endpoint (SPEC §6/§7). The agent ships history over HTTP; the app's
// SSE hub fans live events out to dashboards.
package ship

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

// Event is the wire shape the ingest endpoint validates against (the Zod
// `ingestEventSchema` in app/src/lib/schema/event.ts — the single source of
// truth). Field names/JSON tags MUST stay in sync with that schema.
//
// `id` and `ts` are intentionally omitted: the server stamps them so the agent
// stays simple. `host`/`type`/`pid`/`comm` are required by the schema; the rest
// are optional (hence omitempty), except uid which we always have.
type Event struct {
	Host string `json:"host"`
	Type string `json:"type"`
	PID  uint32 `json:"pid"`
	PPID uint32 `json:"ppid,omitempty"`
	UID  uint32 `json:"uid"`
	User string `json:"user,omitempty"`
	Comm string `json:"comm"`
	Exe  string `json:"exe,omitempty"`
}

// Shipper accumulates events and flushes them as JSON batches — on a size
// threshold (responsiveness under load) or a time interval (so a trickle of
// events still reaches the feed promptly).
type Shipper struct {
	url    string
	host   string
	client *http.Client

	mu  sync.Mutex
	buf []Event

	stop chan struct{}
	done chan struct{}
}

const (
	flushSize     = 64
	flushInterval = 500 * time.Millisecond
)

// New starts a Shipper that posts to url, stamping every event with host.
func New(url, host string) *Shipper {
	s := &Shipper{
		url:    url,
		host:   host,
		client: &http.Client{Timeout: 5 * time.Second},
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	go s.loop()
	return s
}

// Add queues an event, flushing immediately once a batch fills up.
func (s *Shipper) Add(e Event) {
	e.Host = s.host
	s.mu.Lock()
	s.buf = append(s.buf, e)
	full := len(s.buf) >= flushSize
	s.mu.Unlock()
	if full {
		s.flush()
	}
}

func (s *Shipper) loop() {
	defer close(s.done)
	t := time.NewTicker(flushInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.flush()
		case <-s.stop:
			s.flush() // final drain
			return
		}
	}
}

// Close stops the background flusher and drains any remaining events.
func (s *Shipper) Close() {
	close(s.stop)
	<-s.done
}

func (s *Shipper) flush() {
	s.mu.Lock()
	if len(s.buf) == 0 {
		s.mu.Unlock()
		return
	}
	batch := s.buf
	s.buf = nil
	s.mu.Unlock()

	body, err := json.Marshal(batch)
	if err != nil {
		log.Printf("ship: marshal %d events: %v", len(batch), err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		log.Printf("ship: build request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		// Network blip / app not up yet — drop this batch and keep tracing.
		log.Printf("ship: post %d events: %v", len(batch), err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("ship: ingest returned %s for %d events", resp.Status, len(batch))
	}
}
