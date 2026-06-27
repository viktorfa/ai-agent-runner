package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestViewRenders(t *testing.T) {
	cd := t.TempDir()
	t.Setenv("AGENT_RUNNER_CONFIG", cd)
	writeFile(t, filepath.Join(cd, "repos", "demo.conf"), "REPO_PATH=/srv/demo\nREPO_USER=agent\n")

	v := initialModel().View()
	if !strings.Contains(v.Content, "agent-runner") {
		t.Error("view missing the header")
	}
	if !strings.Contains(v.Content, "demo") {
		t.Errorf("view missing the repo name:\n%s", v.Content)
	}
	if !v.AltScreen {
		t.Error("expected the view to request the alt screen")
	}
}

func TestCursorClampsToRepoCount(t *testing.T) {
	cd := t.TempDir()
	t.Setenv("AGENT_RUNNER_CONFIG", cd)
	writeFile(t, filepath.Join(cd, "repos", "a.conf"), "REPO_PATH=/a\n")
	writeFile(t, filepath.Join(cd, "repos", "b.conf"), "REPO_PATH=/b\n")

	m := initialModel()
	if _, ok := m.selected(); !ok {
		t.Fatal("expected a selected repo at cursor 0")
	}
	m.cursor = 99 // out of range
	if _, ok := m.selected(); ok {
		t.Error("selected() should report no selection when the cursor is out of range")
	}
}
