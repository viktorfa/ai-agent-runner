package main

// State layer: a read-only-ish view over the runner's existing operator files and
// commands. It reads the registry, queue, pause flags, `ps`, and systemd; actions
// only call the runner's own primitives (enqueue, the pause flag, the queue dir).
// It never changes the runner's storage format or behaviour.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type repoStatus struct {
	name        string
	repoPath    string
	repoUser    string
	paused      bool
	queue       []string // queued one-off jobs, oldest first (the args, e.g. "--loop steward")
	running     bool
	lastOutcome string // last drain outcome parsed from the newest transcript, if readable
}

type fleet struct {
	configDir     string
	repos         []repoStatus
	watcherActive bool
}

// configDir mirrors the bash control plane: $AGENT_RUNNER_CONFIG or ~/.config/agent-runner.
func configDir() string {
	if d := os.Getenv("AGENT_RUNNER_CONFIG"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "agent-runner")
}

func loadFleet() fleet {
	cd := configDir()
	f := fleet{configDir: cd, watcherActive: watcherActive()}
	confs, _ := filepath.Glob(filepath.Join(cd, "repos", "*.conf"))
	sort.Strings(confs)
	ps := psSnapshot()
	for _, conf := range confs {
		name := strings.TrimSuffix(filepath.Base(conf), ".conf")
		repoPath, repoUser := parseConf(conf)
		f.repos = append(f.repos, repoStatus{
			name:     name,
			repoPath: repoPath,
			repoUser: repoUser,
			paused:   exists(filepath.Join(cd, "repos", name+".paused")),
			queue:    readQueue(filepath.Join(cd, "queue", name)),
			running:  repoPath != "" && strings.Contains(ps, "--workspace "+repoPath),
			// Cheap tail just to extract the outcome line; the transcript viewer
			// reads more on demand.
			lastOutcome: parseOutcome(transcriptTail(repoUser, repoPath, 80)),
		})
	}
	return f
}

// parseConf pulls REPO_PATH / REPO_USER out of a shell-sourced registry conf.
func parseConf(path string) (repoPath, repoUser string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := confValue(line, "REPO_PATH"); ok {
			repoPath = v
		}
		if v, ok := confValue(line, "REPO_USER"); ok {
			repoUser = v
		}
	}
	return repoPath, repoUser
}

// confValue extracts a shell assignment's value the way sourcing the file would:
// the contents of a quoted string (ignoring anything after the closing quote, e.g. a
// trailing `# comment`), or for an unquoted value, up to the first whitespace or `#`.
func confValue(line, key string) (string, bool) {
	if !strings.HasPrefix(line, key+"=") {
		return "", false
	}
	v := strings.TrimSpace(strings.TrimPrefix(line, key+"="))
	if len(v) > 0 && (v[0] == '"' || v[0] == '\'') {
		if end := strings.IndexByte(v[1:], v[0]); end >= 0 {
			return v[1 : 1+end], true
		}
		return v[1:], true // unterminated quote — take the rest
	}
	if i := strings.IndexAny(v, " \t#"); i >= 0 {
		v = v[:i]
	}
	return v, true
}

// readQueue lists pending one-off jobs (FIFO: os.ReadDir returns names sorted).
func readQueue(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var jobs []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		jobs = append(jobs, strings.Join(strings.Fields(string(data)), " "))
	}
	return jobs
}

func psSnapshot() string {
	out, _ := exec.Command("ps", "-eo", "args").Output()
	return string(out)
}

func watcherActive() bool {
	out, _ := exec.Command("systemctl", "--user", "is-active", "agent-watch").Output()
	return strings.TrimSpace(string(out)) == "active"
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// transcriptTail returns the last n lines of a repo's newest loop transcript,
// prefixed with the file path. Transcripts are owned by the repo's agent user, so
// we read them through the existing passwordless `sudo -u <user>` path (read-only).
// Returns "" if there's no transcript, no repo user/path, or sudo can't run
// non-interactively — all non-fatal for a dashboard.
func transcriptTail(repoUser, repoPath string, n int) string {
	if repoUser == "" || repoPath == "" {
		return ""
	}
	script := fmt.Sprintf(
		`f=$(ls -t %q/loop/*.log 2>/dev/null | head -1); [ -n "$f" ] || exit 0; `+
			`printf '%%s\n' "$f"; tail -n %d "$f" 2>/dev/null`,
		repoPath, n)
	out, _ := exec.Command("sudo", "-n", "-u", repoUser, "bash", "-c", script).Output()
	return string(out)
}

// defaultRoles are offered when a repo's .agent/config.json can't be read; they are
// the runner's built-in roles. A repo may define more (e.g. steward).
var defaultRoles = []string{"dev", "qa", "steward"}

// repoRoles returns the roles a repo actually defines — the keys of `prompts` in its
// .agent/config.json (read as the repo's user, since the workspace is agent-owned).
// Falls back to defaultRoles if the config isn't readable. Read on demand (when the
// picker opens), not on every refresh.
func repoRoles(repoUser, repoPath string) []string {
	if repoUser != "" && repoPath != "" {
		path := filepath.Join(repoPath, ".agent", "config.json")
		if out, err := exec.Command("sudo", "-n", "-u", repoUser, "cat", path).Output(); err == nil {
			var cfg struct {
				Prompts map[string]string `json:"prompts"`
			}
			if json.Unmarshal(out, &cfg) == nil && len(cfg.Prompts) > 0 {
				roles := make([]string, 0, len(cfg.Prompts))
				for role := range cfg.Prompts {
					roles = append(roles, role)
				}
				sort.Strings(roles)
				return roles
			}
		}
	}
	return defaultRoles
}

// parseOutcome finds the most recent run-outcome marker in a transcript tail.
func parseOutcome(transcript string) string {
	lines := strings.Split(transcript, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		switch {
		case strings.HasPrefix(l, "Done:"),
			strings.HasPrefix(l, "drain stalled"),
			strings.HasPrefix(l, "agent failed"),
			strings.Contains(l, "board read failed"):
			return l
		case strings.Contains(l, "no ready tasks"):
			return "no ready tasks"
		}
	}
	return ""
}

// --- actions: each maps to a runner primitive, no new state ---

func togglePause(cd, repo string) error {
	p := filepath.Join(cd, "repos", repo+".paused")
	if exists(p) {
		return os.Remove(p)
	}
	return os.WriteFile(p, nil, 0o644)
}

// clearQueue cancels all pending one-off jobs for a repo (removes the queue dir;
// enqueue recreates it, and the watcher's glob tolerates its absence).
func clearQueue(cd, repo string) error {
	return os.RemoveAll(filepath.Join(cd, "queue", repo))
}

// enqueue writes a one-off job file, mirroring bin/enqueue's contract exactly:
// a FIFO-sortable UTC-timestamp+pid filename under queue/<repo>/, one arg per line
// (the watcher reads it back with mapfile). Done directly — same as the pause/clear
// file ops above — so the TUI is a self-contained binary with no path to bin/enqueue
// to resolve. It writes the existing storage in the existing format; it does not
// change the tool. (If bin/enqueue's format ever changes, keep this in step.)
func enqueue(cd, repo string, args ...string) error {
	dir := filepath.Join(cd, "queue", repo)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	name := fmt.Sprintf("%s-%d", time.Now().UTC().Format("20060102T150405.000000000"), os.Getpid())
	return os.WriteFile(filepath.Join(dir, name), []byte(strings.Join(args, "\n")+"\n"), 0o644)
}
