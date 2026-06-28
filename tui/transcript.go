package main

// Pretty-printing for the transcript viewer. The runner's transcript is codex's raw
// `--json` event stream (one JSON object per line) interleaved with orchestrate's plain
// log lines. Read from the watcher journal (`-o short-iso`) it gains a timestamp per
// line; this turns each line into a compact, human-readable entry:
//
//   19:40:03  $ pnpm lint  ✓
//   19:40:29  💬 Final lint is clean. Marking TASK-126 done…
//   19:41:22  $ git commit -m "fix: …"  ✓
//
// Anything that doesn't parse falls back to its raw text — content is never dropped
// silently except known noise (PAM sessions, git diffstat file rows).

import (
	"encoding/json"
	"fmt"
	"strings"
)

type codexEvent struct {
	Type string `json:"type"` // "item.started" | "item.completed" | …
	Item struct {
		Type     string `json:"type"` // "command_execution" | "agent_message" | …
		Command  string `json:"command"`
		Text     string `json:"text"`
		Output   string `json:"aggregated_output"`
		ExitCode *int   `json:"exit_code"`
	} `json:"item"`
}

// renderTranscript turns raw `journalctl -o short-iso` output into a timestamped,
// readable transcript.
func renderTranscript(journalOut string) string {
	raw := strings.Split(strings.TrimRight(journalOut, "\n"), "\n")
	var out []string
	for i, line := range raw {
		ts, msg := splitJournalLine(line)
		if msg == "" || isTranscriptNoise(msg) {
			continue
		}
		if text, keep := renderTranscriptEvent(msg, i == len(raw)-1); keep {
			out = append(out, ts+"  "+text)
		}
	}
	return strings.Join(out, "\n")
}

// splitJournalLine pulls HH:MM:SS and the message out of a short-iso journal line
// ("2026-06-28T19:40:02+00:00 host unit[pid]: msg").
func splitJournalLine(line string) (hms, msg string) {
	sp := strings.IndexByte(line, ' ')
	if sp < 0 {
		return "", line
	}
	iso := line[:sp]
	hms = iso
	if t := strings.IndexByte(iso, 'T'); t >= 0 && len(iso) >= t+9 {
		hms = iso[t+1 : t+9] // the HH:MM:SS slice
	}
	rest := line[sp+1:]
	if i := strings.Index(rest, "]: "); i >= 0 {
		return hms, rest[i+3:]
	}
	return hms, rest
}

func isTranscriptNoise(msg string) bool {
	return strings.Contains(msg, "pam_unix(") ||
		strings.HasPrefix(msg, "create mode ") ||
		strings.HasPrefix(msg, "delete mode ")
}

// renderTranscriptEvent renders one message. Plain (non-JSON) lines pass through; codex
// events become a one-line summary. `isLast` keeps the currently-running command visible
// (its item.started has no matching completed yet).
func renderTranscriptEvent(msg string, isLast bool) (string, bool) {
	if !strings.HasPrefix(msg, "{") {
		return msg, true // orchestrate / git output line
	}
	var ev codexEvent
	if json.Unmarshal([]byte(msg), &ev) != nil {
		return msg, true // unparseable JSON — show raw rather than lose it
	}
	switch ev.Item.Type {
	case "agent_message":
		return "💬 " + collapseWS(ev.Item.Text), true
	case "command_execution":
		if ev.Type == "item.started" {
			if !isLast {
				return "", false // the matching completed event will show it
			}
			return "⟳ " + shortCmd(ev.Item.Command), true
		}
		if ev.Item.ExitCode != nil && *ev.Item.ExitCode != 0 {
			line := fmt.Sprintf("$ %s  ✗ exit %d", shortCmd(ev.Item.Command), *ev.Item.ExitCode)
			if snip := lastNonEmpty(ev.Item.Output); snip != "" {
				line += " — " + snip
			}
			return line, true
		}
		return "$ " + shortCmd(ev.Item.Command) + "  ✓", true
	}
	return "", false // reasoning and other event types — drop from the transcript
}

// shortCmd unwraps the `bash -lc '…'` wrapper codex uses and collapses whitespace.
func shortCmd(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	for _, p := range []string{"/bin/bash -lc ", "bash -lc ", "/bin/bash -c ", "bash -c "} {
		if strings.HasPrefix(cmd, p) {
			cmd = strings.Trim(strings.TrimPrefix(cmd, p), "'\"")
			break
		}
	}
	return truncate(collapseWS(cmd), 120)
}

func collapseWS(s string) string { return strings.Join(strings.Fields(s), " ") }

func lastNonEmpty(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return truncate(t, 120)
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len([]rune(s)) > n {
		return string([]rune(s)[:n-1]) + "…"
	}
	return s
}
