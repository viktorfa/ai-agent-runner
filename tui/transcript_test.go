package main

import (
	"strings"
	"testing"
)

func TestSplitJournalLine(t *testing.T) {
	hms, msg := splitJournalLine(`2026-06-28T19:40:03+00:00 t14s watch[3298534]: hello world`)
	if hms != "19:40:03" || msg != "hello world" {
		t.Errorf("splitJournalLine = %q,%q; want 19:40:03,\"hello world\"", hms, msg)
	}
}

func TestShortCmd(t *testing.T) {
	if got := shortCmd(`/bin/bash -lc 'pnpm lint'`); got != "pnpm lint" {
		t.Errorf("shortCmd = %q; want pnpm lint", got)
	}
}

func TestRenderTranscript(t *testing.T) {
	pre := "2026-06-28T19:40:03+00:00 t14s watch[1]: "
	in := strings.Join([]string{
		pre + `{"type":"item.started","item":{"type":"command_execution","command":"/bin/bash -lc 'pnpm lint'","status":"in_progress"}}`,
		pre + `{"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -lc 'pnpm lint'","aggregated_output":"ok","exit_code":0,"status":"completed"}}`,
		pre + `{"type":"item.completed","item":{"type":"command_execution","command":"/bin/bash -lc 'pnpm build'","aggregated_output":"line1\nBUILD FAILED","exit_code":1,"status":"completed"}}`,
		pre + `{"type":"item.completed","item":{"type":"agent_message","text":"Marking TASK-1 done."}}`,
		pre + `=== iteration 1 (drain) ===`,
		pre + `pam_unix(sudo-i:session): session closed for user agent`,
		pre + `{"type":"item.started","item":{"type":"command_execution","command":"/bin/bash -lc 'pnpm test'","status":"in_progress"}}`,
	}, "\n")

	want := []string{
		"19:40:03  $ pnpm lint  ✓",                        // started-lint (not last) dropped; completed shown
		"19:40:03  $ pnpm build  ✗ exit 1 — BUILD FAILED", // failure shows the last output line
		"19:40:03  💬 Marking TASK-1 done.",
		"19:40:03  === iteration 1 (drain) ===", // plain orchestrate line passes through
		"19:40:03  ⟳ pnpm test",                 // last line is a started → kept as running
	}
	got := strings.Split(renderTranscript(in), "\n")
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %q; want %q", i, got[i], want[i])
		}
	}
	if strings.Contains(strings.Join(got, "\n"), "pam_unix") {
		t.Error("PAM session line should be filtered out")
	}
}
