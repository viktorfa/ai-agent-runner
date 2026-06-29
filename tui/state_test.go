package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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
	writeFile(t, filepath.Join(cd, "status", "demo"), "status=ok\noutcome=Done: 0 iteration(s), ok.\n")

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
	if r.lastRun.status != "ok" || r.lastRun.outcome != "Done: 0 iteration(s), ok." {
		t.Errorf("lastRun = %+v", r.lastRun)
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

func TestParseActivityLogAndHeatmap(t *testing.T) {
	out := "2026-06-28T10:30:00+00:00\tfix: a\n" +
		"2026-06-28T10:45:00+00:00\tchore: b\n" +
		"2026-06-28T09:15:00+00:00\tfeat: c\n" +
		"malformed line without a tab\n"
	commits := parseActivityLog(out)
	if len(commits) != 3 {
		t.Fatalf("parseActivityLog got %d commits; want 3 (malformed line dropped)", len(commits))
	}
	if commits[0].subject != "fix: a" {
		t.Errorf("commit[0] = %+v", commits[0])
	}

	now := time.Date(2026, 6, 28, 10, 30, 0, 0, time.UTC)
	cells := (repoActivity{commits: commits}).heatmap(3, now) // hourly: 08, 09, 10 (oldest first)
	if len(cells) != 3 {
		t.Fatalf("heatmap got %d cells; want 3", len(cells))
	}
	if cells[2].key != "2026-06-28T10" {
		t.Errorf("cells[2].key = %q; want 2026-06-28T10", cells[2].key)
	}
	if cells[0].count != 0 || cells[1].count != 1 || cells[2].count != 2 {
		t.Errorf("counts = %d,%d,%d; want 0,1,2", cells[0].count, cells[1].count, cells[2].count)
	}
}

func TestParseAheadBehind(t *testing.T) {
	// `git rev-list --left-right --count base...work` → "<behind>\t<ahead>".
	ahead, behind, ok := parseAheadBehind("0\t4\n")
	if !ok || ahead != 4 || behind != 0 {
		t.Errorf("parseAheadBehind = %d,%d,%v; want 4,0,true", ahead, behind, ok)
	}
	if a, b, ok := parseAheadBehind("2\t3"); !ok || b != 2 || a != 3 {
		t.Errorf("parseAheadBehind = %d,%d,%v; want 3,2,true", a, b, ok)
	}
	if _, _, ok := parseAheadBehind(""); ok {
		t.Error("parseAheadBehind should reject empty output (missing work ref)")
	}
	if _, _, ok := parseAheadBehind("1\tx"); ok {
		t.Error("parseAheadBehind should reject a non-integer field")
	}
}

func TestParseWorktreeBranches(t *testing.T) {
	out := "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n" +
		"worktree /repo/.worktrees/TASK-1\nHEAD def\nbranch refs/heads/auto/task-1\n\n" +
		"worktree /repo/.worktrees/TASK-2\nHEAD ghi\nbranch refs/heads/auto/task-2\n\n" +
		"worktree /repo/staging\nHEAD jkl\nbranch refs/heads/auto/work\n"
	got := parseWorktreeBranches(out, "auto/work")
	// in-flight task worktrees only — the main checkout and the staging branch drop out.
	if len(got) != 2 || got[0] != "auto/task-1" || got[1] != "auto/task-2" {
		t.Errorf("parseWorktreeBranches = %v; want [auto/task-1 auto/task-2]", got)
	}
	if got := parseWorktreeBranches("worktree /repo\nbranch refs/heads/main\n", "auto/work"); got != nil {
		t.Errorf("parseWorktreeBranches with no auto/* worktrees = %v; want nil", got)
	}
}

func TestReadRunStatus(t *testing.T) {
	cd := t.TempDir()
	writeFile(t, filepath.Join(cd, "status", "demo"),
		"time=2026-06-27T13:04:34+00:00\nran=--drain\nstatus=ok\noutcome=Done: 2 iteration(s), ok.\n")
	s := readRunStatus(cd, "demo")
	if s.status != "ok" || s.ran != "--drain" || s.outcome != "Done: 2 iteration(s), ok." || s.time == "" {
		t.Errorf("readRunStatus = %+v", s)
	}
	if got := readRunStatus(cd, "missing"); got.time != "" || got.status != "" {
		t.Errorf("expected zero runStatus for a missing file, got %+v", got)
	}
}
