// Package probe implements the "camera" layer of dynamic instrumentation.
//
// Coverage counters (go tool cover) are the "stopwatch" — they say how often a
// path runs. Probes are the "camera": they capture the actual data values
// flowing through a point (args, return values, error values) and emit them as
// structured JSONL. A contract judge then compares each snapshot against a
// declared expectation and flags deviations.
//
// Minimal version: capture the error value at silent-error-discard sites and
// compare it against the contract "errors must be nil or provably benign".
package probe

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Event is one data snapshot captured at a probe point.
type Event struct {
	Probe  string         `json:"probe"`  // probe point id, e.g. "save.writefile"
	Time   time.Time      `json:"time"`   // capture timestamp
	Source string         `json:"source"` // where the expectation comes from: static-rule / llm-design / runtime-invariant
	Fields map[string]any `json:"fields"` // captured values (err, path, bytes, benign...)
}

// Sink appends probe events to a JSONL file. Append-only, so no locking
// across goroutines beyond a short mutex on the writer.
type Sink struct {
	mu   sync.Mutex
	path string
	fh   *os.File
}

// NewSink opens (or creates) path for appending and returns a Sink.
func NewSink(path string) (*Sink, error) {
	fh, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	return &Sink{path: path, fh: fh}, nil
}

// Emit serializes and appends one event.
func (s *Sink) Emit(probeName, source string, fields map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := Event{
		Probe:  probeName,
		Time:   time.Now(),
		Source: source,
		Fields: fields,
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = s.fh.Write(append(data, '\n'))
	return err
}

// Close closes the underlying file.
func (s *Sink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fh.Close()
}
