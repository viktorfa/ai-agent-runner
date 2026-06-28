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
	name      string
	repoPath  string
	repoUser  string
	paused    bool
	queue     []string // queued one-off jobs, oldest first (the args, e.g. "--loop steward")
	running   bool
	watcherOn bool      // this repo's watcher unit (or the legacy single watcher) is active
	lastRun   runStatus // last recorded run outcome (from the watcher's status file)
}

// runStatus is the watcher's per-repo record of the last real run, read from
// $CONFIG_DIR/status/<repo>. Empty (time == "") when no run has been recorded yet.
type runStatus struct {
	time    string // RFC3339
	ran     string // what ran, e.g. "--drain" or "--loop steward"
	status  string // "ok" or "failed (exit N)"
	outcome string // the final outcome line, e.g. "Done: 2 iteration(s), ok."
}

type fleet struct {
	configDir string
	repos     []repoStatus
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
	f := fleet{configDir: cd}
	confs, _ := filepath.Glob(filepath.Join(cd, "repos", "*.conf"))
	sort.Strings(confs)
	ps := psSnapshot()
	for _, conf := range confs {
		name := strings.TrimSuffix(filepath.Base(conf), ".conf")
		repoPath, repoUser := parseConf(conf)
		f.repos = append(f.repos, repoStatus{
			name:      name,
			repoPath:  repoPath,
			repoUser:  repoUser,
			paused:    exists(filepath.Join(cd, "repos", name+".paused")),
			queue:     readQueue(filepath.Join(cd, "queue", name)),
			running:   repoPath != "" && strings.Contains(ps, "--workspace "+repoPath),
			watcherOn: repoWatcherActive(name),
			// Last outcome comes from the watcher's status file (operator-readable,
			// no sudo). The transcript viewer still reads the log on demand.
			lastRun: readRunStatus(cd, name),
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

func systemctlActive(unit string) bool {
	out, _ := exec.Command("systemctl", "--user", "is-active", unit).Output()
	return strings.TrimSpace(string(out)) == "active"
}

// repoWatcherActive reports whether a repo is being watched: its own per-repo unit
// (agent-watch@<repo>) or the legacy single watcher that serves all repos. The OR keeps
// the answer correct across the migration from one to the other.
func repoWatcherActive(repo string) bool {
	return systemctlActive("agent-watch@"+repo) || systemctlActive("agent-watch")
}

// activitySignals are the watcher-journal lines worth surfacing as a fleet heartbeat;
// everything else (git diffstats, PAM sessions, branch-tracking noise, codex JSON) is
// dropped.
var activitySignals = []string{
	"dispatch:", "=== iteration", "Done:", "no ready tasks", "drain stalled",
	"agent failed", "board read failed", "parked ", "conflicts with", "[watch ", "exited",
}

// activityFeed returns the most recent meaningful watcher-journal lines for a repo,
// oldest first. Reads both the per-repo unit (agent-watch@<repo>) and the legacy
// single watcher, so it works in either mode; from the operator's own user journal
// (`journalctl --user`) — no sudo.
func activityFeed(repo string, maxLines int) []string {
	out, err := exec.Command("journalctl", "--user",
		"-u", "agent-watch@"+repo, "-u", "agent-watch",
		"-n", "400", "--no-pager", "-o", "cat").Output()
	if err != nil {
		return nil
	}
	var lines []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		for _, sig := range activitySignals {
			if strings.Contains(line, sig) {
				lines = append(lines, line)
				break
			}
		}
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines
}

// --- activity history (heatmap + timeline), from auto/work commits ---

type commitEntry struct {
	when    time.Time
	subject string
}

type repoActivity struct {
	commits []commitEntry // newest first, within the window
}

// loadRepoActivity reads recent commits on a repo's checked-out work branch (the
// committer date + subject) via the existing sudo path, read-only — the commits are
// the record of work that landed. On-demand (when the activity view opens), not on the
// refresh tick.
func loadRepoActivity(repoUser, repoPath string, hours int) repoActivity {
	if repoUser == "" || repoPath == "" {
		return repoActivity{}
	}
	out, err := exec.Command("sudo", "-n", "-u", repoUser,
		"git", "-C", repoPath, "log",
		"--since="+fmt.Sprintf("%d hours ago", hours), "-n", "500",
		"--format=%cI%x09%s").Output()
	if err != nil {
		return repoActivity{}
	}
	return repoActivity{commits: parseActivityLog(string(out))}
}

// parseActivityLog turns `git log --format=%cI<TAB>%s` output into commit entries.
func parseActivityLog(out string) []commitEntry {
	var commits []commitEntry
	for _, line := range strings.Split(out, "\n") {
		iso, subject, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		t, err := time.Parse(time.RFC3339, iso)
		if err != nil {
			continue
		}
		commits = append(commits, commitEntry{when: t, subject: subject})
	}
	return commits
}

type heatBucket struct {
	key   string // hour key, "2006-01-02T15"
	count int
}

// heatmap buckets commits into the last `hours` hourly slots ending at `now` (oldest
// first), for a recent-activity strip.
func (a repoActivity) heatmap(hours int, now time.Time) []heatBucket {
	byHour := map[string]int{}
	for _, c := range a.commits {
		byHour[c.when.Format("2006-01-02T15")]++
	}
	cells := make([]heatBucket, 0, hours)
	for i := hours - 1; i >= 0; i-- {
		key := now.Add(time.Duration(-i) * time.Hour).Format("2006-01-02T15")
		cells = append(cells, heatBucket{key: key, count: byHour[key]})
	}
	return cells
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// transcriptJournal returns the last n watcher-journal lines for a repo, with ISO
// timestamps, prettified into a readable transcript (see renderTranscript). Read from
// the operator's own user journal (`journalctl --user`) — no sudo. "" on error.
func transcriptJournal(repo string, n int) string {
	out, err := exec.Command("journalctl", "--user", "-u", "agent-watch@"+repo,
		"-n", fmt.Sprintf("%d", n), "--no-pager", "-o", "short-iso").Output()
	if err != nil {
		return ""
	}
	return renderTranscript(string(out))
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

// readRunStatus loads the watcher's last-run record for a repo (key=value lines from
// $CONFIG_DIR/status/<repo>). Operator-readable, so no sudo. Zero value if none yet.
func readRunStatus(cd, repo string) runStatus {
	var s runStatus
	data, err := os.ReadFile(filepath.Join(cd, "status", repo))
	if err != nil {
		return s
	}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "time":
			s.time = v
		case "ran":
			s.ran = v
		case "status":
			s.status = v
		case "outcome":
			s.outcome = v
		}
	}
	return s
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
