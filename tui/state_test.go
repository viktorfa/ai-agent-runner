package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfValue(t *testing.T) {
	cases := map[string]string{
		`REPO_PATH="/a/b"`:               "/a/b",
		`REPO_PATH=/a/b`:                 "/a/b",
		`REPO_PATH='/a/b'`:               "/a/b",
		`REPO_PATH="/a/b"   # a comment`: "/a/b", // quoted value + trailing comment
		`REPO_PATH=/a/b # a comment`:     "/a/b", // unquoted value + trailing comment
	}
	for line, want := range cases {
		if got, ok := confValue(line, "REPO_PATH"); !ok || got != want {
			t.Errorf("confValue(%q) = %q,%v; want %q", line, got, ok, want)
		}
	}
	if _, ok := confValue("REPO_USER=x", "REPO_PATH"); ok {
		t.Error("confValue matched the wrong key")
	}
}

func TestReadQueueIsFIFO(t *testing.T) {
	dir := t.TempDir()
	// names sort lexically == enqueue order
	writeFile(t, filepath.Join(dir, "20260101T000001.0-1"), "--loop\nsteward\n")
	writeFile(t, filepath.Join(dir, "20260101T000002.0-2"), "--loop\nqa\n")
	got := readQueue(dir)
	want := []string{"--loop steward", "--loop qa"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("readQueue = %v; want %v", got, want)
	}
	if readQueue(filepath.Join(dir, "missing")) != nil {
		t.Error("readQueue of a missing dir should be nil")
	}
}

func TestLoadFleetReadsRegistryQueueAndPause(t *testing.T) {
	cd := t.TempDir()
	t.Setenv("AGENT_RUNNER_CONFIG", cd)
	writeFile(t, filepath.Join(cd, "repos", "demo.conf"), "REPO_PATH=\"/srv/demo\"\nREPO_USER=\"agent\"\n")
	writeFile(t, filepath.Join(cd, "repos", "demo.paused"), "")
	writeFile(t, filepath.Join(cd, "queue", "demo", "20260101T000001.0-1"), "--loop\nsteward\n")

	f := loadFleet()
	if f.configDir != cd || len(f.repos) != 1 {
		t.Fatalf("loadFleet repos = %d; want 1 (cd=%s)", len(f.repos), f.configDir)
	}
	r := f.repos[0]
	if r.name != "demo" || r.repoPath != "/srv/demo" || r.repoUser != "agent" {
		t.Errorf("parsed repo = %+v", r)
	}
	if !r.paused {
		t.Error("expected paused=true")
	}
	if len(r.queue) != 1 || r.queue[0] != "--loop steward" {
		t.Errorf("queue = %v", r.queue)
	}
}

func TestTogglePauseAndClearQueue(t *testing.T) {
	cd := t.TempDir()
	writeFile(t, filepath.Join(cd, "repos", "demo.conf"), "REPO_PATH=/x\n")

	if err := togglePause(cd, "demo"); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(cd, "repos", "demo.paused")) {
		t.Fatal("togglePause should create the flag")
	}
	if err := togglePause(cd, "demo"); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(cd, "repos", "demo.paused")) {
		t.Fatal("togglePause should remove the flag on the second call")
	}

	writeFile(t, filepath.Join(cd, "queue", "demo", "job1"), "--loop steward")
	if err := clearQueue(cd, "demo"); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(cd, "queue", "demo")) {
		t.Fatal("clearQueue should remove the repo's queue dir")
	}
}

func TestEnqueueRoundTrips(t *testing.T) {
	cd := t.TempDir()
	if err := enqueue(cd, "demo", "--loop", "steward"); err != nil {
		t.Fatal(err)
	}
	// readQueue mirrors the watcher's read-back, so a clean round-trip proves the
	// written file matches the format the watcher consumes.
	got := readQueue(filepath.Join(cd, "queue", "demo"))
	if len(got) != 1 || got[0] != "--loop steward" {
		t.Errorf("after enqueue, readQueue = %v; want [\"--loop steward\"]", got)
	}
}
