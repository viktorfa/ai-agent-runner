// agent-runner TUI — an operator dashboard over the runner's existing files and
// commands. Read-only view of the registry, queue, pause flags, running drains, the
// watcher, and (on demand) live transcripts; actions only write the same files the
// control plane does. It changes nothing about the runner's functionality, state, or
// storage.
package main

import (
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

const refreshInterval = 3 * time.Second

type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(refreshInterval, func(t time.Time) tea.Msg { return tickMsg(t) })
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true)
	selStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("212"))
	dimStyle   = lipgloss.NewStyle().Faint(true)
	okStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	warnStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	errStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	infoStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))
)

type viewMode int

const (
	modeList viewMode = iota
	modeTranscript
	modeEnqueue
	modeActivity
)

const (
	activityHours     = 48 // heatmap window (hourly buckets)
	activityTimelineN = 15 // commits shown in the timeline
	heatGroup         = 6  // visual gap every N hourly cells
)

const chromeHeight = 4 // header + footer rows reserved around the viewport

type model struct {
	fleet       fleet
	cursor      int
	mode        viewMode
	vp          viewport.Model
	vpName      string   // repo whose transcript the viewport shows
	roles       []string // role picker choices for the selected repo (modeEnqueue)
	roleCursor  int
	iterations  int          // chosen iteration count in the enqueue picker (default 1)
	activity    []string     // filtered watcher-journal feed (fleet heartbeat)
	selActivity repoActivity // selected repo's commit history (main-view heatmap + the 'a' view)
	staging     staging      // selected repo's staging branch + in-flight worktrees
	width       int
	height      int
	message     string
}

const activityBuffer = 40 // feed lines to keep; the panel shows as many as fit the space

const maxIterations = 9 // upper bound for the enqueue picker; use the CLI for more

const transcriptLines = 600 // journal lines to read for the transcript viewer

func initialModel() model {
	m := model{fleet: loadFleet(), vp: viewport.New()}
	m.refreshActivity()
	m.refreshSelActivity()
	m.refreshStaging()
	return m
}

// refreshActivity loads the selected repo's activity feed (its per-repo journal) — cheap,
// runs on every tick.
func (m *model) refreshActivity() {
	if r, ok := m.selected(); ok {
		m.activity = activityFeed(r.name, activityBuffer)
	} else {
		m.activity = nil
	}
}

// refreshSelActivity loads the selected repo's commit history (the heatmap source). This
// is a `git log` read, heavier than the journal feed, so it runs only on selection
// change / explicit refresh — not on every tick (commits don't move every 3s).
func (m *model) refreshSelActivity() {
	if r, ok := m.selected(); ok {
		m.selActivity = loadRepoActivity(r.repoUser, r.repoPath, activityHours)
	} else {
		m.selActivity = repoActivity{}
	}
}

// refreshStaging loads the selected repo's staging snapshot (work-branch ahead/behind +
// in-flight worktrees). A few quick read-only git calls for one repo, so it runs on the
// tick too — unlike the commit history, staging moves second-to-second during a drain.
func (m *model) refreshStaging() {
	if r, ok := m.selected(); ok {
		m.staging = loadStaging(r.repoUser, r.repoPath)
	} else {
		m.staging = staging{}
	}
}

func (m model) Init() tea.Cmd {
	return tick()
}

func (m model) selected() (repoStatus, bool) {
	if m.cursor >= 0 && m.cursor < len(m.fleet.repos) {
		return m.fleet.repos[m.cursor], true
	}
	return repoStatus{}, false
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.vp.SetWidth(msg.Width)
		m.vp.SetHeight(max(1, msg.Height-chromeHeight))
		return m, nil
	case tickMsg:
		switch m.mode {
		case modeTranscript:
			m.refreshTranscript() // re-read the viewed repo's journal (no sudo)
		case modeList:
			m.fleet = loadFleet()
			m.refreshActivity()
			m.refreshStaging()
		}
		// modeEnqueue: leave the fleet steady while the transient picker is open.
		return m, tick()
	case tea.KeyPressMsg:
		switch m.mode {
		case modeTranscript:
			return m.updateTranscript(msg)
		case modeEnqueue:
			return m.updateEnqueue(msg)
		case modeActivity:
			return m.updateActivity(msg)
		default:
			return m.updateList(msg)
		}
	}
	if m.mode == modeTranscript {
		var cmd tea.Cmd
		m.vp, cmd = m.vp.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m model) updateList(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
			m.refreshActivity()
			m.refreshSelActivity()
			m.refreshStaging()
		}
	case "down", "j":
		if m.cursor < len(m.fleet.repos)-1 {
			m.cursor++
			m.refreshActivity()
			m.refreshSelActivity()
			m.refreshStaging()
		}
	case "enter", "t":
		if r, ok := m.selected(); ok {
			m.openTranscript(r)
		}
	case "a":
		m.mode = modeActivity
	case "r":
		m.fleet = loadFleet()
		m.refreshActivity()
		m.refreshSelActivity()
		m.refreshStaging()
		m.message = "refreshed"
	case "e":
		if r, ok := m.selected(); ok {
			m.roles = repoRoles(r.repoUser, r.repoPath)
			m.roleCursor = 0
			m.iterations = 1
			m.mode = modeEnqueue
		}
	case "p":
		if r, ok := m.selected(); ok {
			m.act("toggled pause for "+r.name, togglePause(m.fleet.configDir, r.name))
		}
	case "w":
		if r, ok := m.selected(); ok {
			verb := "enabled"
			if r.watcherOn {
				verb = "disabled"
			}
			m.act(verb+" watcher for "+r.name, setWatcher(r.name, !r.watcherOn))
		}
	case "x":
		if r, ok := m.selected(); ok {
			m.act("cleared queue for "+r.name, clearQueue(m.fleet.configDir, r.name))
		}
	}
	return m, nil
}

func (m model) updateTranscript(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc", "backspace":
		m.mode = modeList
		return m, nil
	}
	var cmd tea.Cmd
	m.vp, cmd = m.vp.Update(msg) // scroll keys: ↑/↓, pgup/pgdn, etc.
	return m, cmd
}

func (m model) updateEnqueue(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.mode = modeList
	case "up", "k":
		if m.roleCursor > 0 {
			m.roleCursor--
		}
	case "down", "j":
		if m.roleCursor < len(m.roles)-1 {
			m.roleCursor++
		}
	case "left", "h", "-":
		if m.iterations > 1 {
			m.iterations--
		}
	case "right", "l", "+":
		if m.iterations < maxIterations {
			m.iterations++
		}
	case "enter":
		if r, ok := m.selected(); ok && m.roleCursor < len(m.roles) {
			role := m.roles[m.roleCursor]
			args := []string{"--loop", role}
			label := "queued " + role
			if m.iterations > 1 { // omit --iterations 1 (the default) to keep it tidy
				args = append(args, "--iterations", fmt.Sprintf("%d", m.iterations))
				label += fmt.Sprintf(" ×%d", m.iterations)
			}
			m.act(label+" for "+r.name, enqueue(m.fleet.configDir, r.name, args...))
		}
		m.mode = modeList
	}
	return m, nil
}

// act records an action's outcome and refreshes the fleet view.
func (m *model) act(ok string, err error) {
	if err != nil {
		m.message = "error: " + err.Error()
	} else {
		m.message = ok
	}
	m.fleet = loadFleet()
	m.refreshActivity()
}

func (m *model) openTranscript(r repoStatus) {
	m.mode = modeTranscript
	m.vpName = r.name
	m.vp.SetContent(transcriptOr(transcriptJournal(r.name, transcriptLines), r.name))
	m.vp.GotoBottom()
}

// refreshTranscript re-reads the viewed transcript, following the tail only if the
// user is already at the bottom (so scrolling back up isn't yanked away).
func (m *model) refreshTranscript() {
	atBottom := m.vp.AtBottom()
	content := transcriptJournal(m.vpName, transcriptLines)
	if strings.TrimSpace(content) == "" {
		return
	}
	m.vp.SetContent(content)
	if atBottom {
		m.vp.GotoBottom()
	}
}

func transcriptOr(content, name string) string {
	if strings.TrimSpace(content) == "" {
		return "(no transcript yet for " + name + ")"
	}
	return content
}

func (m model) updateActivity(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "a":
		m.mode = modeList
	case "r":
		m.refreshSelActivity()
	}
	return m, nil
}

func (m model) View() tea.View {
	var content string
	switch m.mode {
	case modeTranscript:
		content = m.transcriptView()
	case modeEnqueue:
		content = m.enqueueView()
	case modeActivity:
		content = m.activityView()
	default:
		content = m.listView()
	}
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

func (m model) enqueueView() string {
	var b strings.Builder
	name := ""
	if r, ok := m.selected(); ok {
		name = r.name
	}
	b.WriteString(titleStyle.Render("Enqueue a one-off on "+name) + "\n")
	b.WriteString(dimStyle.Render("roles defined in this repo's .agent/config.json") + "\n\n")
	for i, role := range m.roles {
		cursor := "  "
		label := role
		if i == m.roleCursor {
			cursor = selStyle.Render("> ")
			label = selStyle.Render(role)
		}
		b.WriteString(cursor + label + "\n")
	}
	b.WriteString("\n" + dimStyle.Render("iterations: ") +
		selStyle.Render(fmt.Sprintf("%d", m.iterations)) + dimStyle.Render("  (←/→ to change)") + "\n")
	b.WriteString("\n" + dimStyle.Render("↑/↓ role · ←/→ iterations · enter queue · esc cancel"))
	return b.String()
}

func (m model) transcriptView() string {
	header := titleStyle.Render(m.vpName+" — transcript") + "  " +
		dimStyle.Render("(timestamped, follows the tail)")
	footer := dimStyle.Render("↑/↓ pgup/pgdn scroll · esc/q back · refreshes every 3s")
	return header + "\n" + m.vp.View() + "\n" + footer
}

// heatRow renders the contribution cells for the selected repo (oldest → newest, a gap
// between weeks).
func (m model) heatRow() string {
	var b strings.Builder
	for i, dc := range m.selActivity.heatmap(activityHours, time.Now()) {
		if i > 0 && i%heatGroup == 0 {
			b.WriteString(" ")
		}
		b.WriteString(heatCell(dc.count))
	}
	return b.String()
}

// heatmapCompact is the one-glance heatmap shown at the bottom of the main view.
func (m model) heatmapCompact() string {
	return titleStyle.Render("commits") +
		dimStyle.Render(fmt.Sprintf(" · last %dh (press a for timeline)", activityHours)) +
		"\n" + m.heatRow()
}

// activityView is the full 'a' screen: heatmap + legend + recent-commit timeline.
func (m model) activityView() string {
	name := ""
	if r, ok := m.selected(); ok {
		name = r.name
	}
	var b strings.Builder
	b.WriteString(titleStyle.Render(name+" — activity") + "  " +
		dimStyle.Render(fmt.Sprintf("(auto/work commits, last %d hours)", activityHours)) + "\n\n")
	b.WriteString(m.heatRow() + "\n")
	b.WriteString(dimStyle.Render("less ") +
		heatCell(0) + heatCell(1) + heatCell(3) + heatCell(6) + heatCell(10) +
		dimStyle.Render(" more") + "\n\n")

	b.WriteString(titleStyle.Render("recent") + "\n")
	if len(m.selActivity.commits) == 0 {
		b.WriteString(dimStyle.Render("(no commits on the work branch in this window)") + "\n")
	}
	for i, c := range m.selActivity.commits {
		if i >= activityTimelineN {
			break
		}
		subj := c.subject
		if maxw := m.width - 16; maxw > 12 && len(subj) > maxw {
			subj = subj[:maxw-1] + "…"
		}
		b.WriteString(dimStyle.Render(c.when.Format("01-02 15:04")) + "  " + subj + "\n")
	}

	b.WriteString("\n" + dimStyle.Render("esc/q back · r refresh"))
	return b.String()
}

// heatCell renders one day of the contribution heatmap, shaded by commit count.
func heatCell(count int) string {
	switch {
	case count == 0:
		return dimStyle.Render("·")
	case count <= 2:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("28")).Render("■")
	case count <= 5:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("34")).Render("■")
	case count <= 9:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("40")).Render("■")
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("46")).Render("■")
	}
}

const footerKeys = "↑/↓ move · enter/t transcript · a activity · e enqueue (pick role) · p pause · w watch on/off · x clear queue · r refresh · q quit"

func clamp(v, lo, hi int) int { return max(lo, min(v, hi)) }

func (m model) headerLine() string {
	on := 0
	for _, r := range m.fleet.repos {
		if r.watcherOn {
			on++
		}
	}
	label := fmt.Sprintf("watchers: %d/%d active", on, len(m.fleet.repos))
	style := okStyle
	if on < len(m.fleet.repos) {
		style = warnStyle
	}
	return titleStyle.Render("agent-runner") + "   " + style.Render(label)
}

func watcherLabel(r repoStatus) string {
	if r.watcherOn {
		return okStyle.Render("on")
	}
	return warnStyle.Render("off")
}

func (m model) repoListColumn() string {
	if len(m.fleet.repos) == 0 {
		return dimStyle.Render("no repos in " + m.fleet.configDir + "/repos/")
	}
	rows := make([]string, len(m.fleet.repos))
	for i, r := range m.fleet.repos {
		cursor := "  "
		name := r.name
		if i == m.cursor {
			cursor = selStyle.Render("> ")
			name = selStyle.Render(name)
		}
		rows[i] = cursor + name + "  " + strings.Join(tags(r), " ")
	}
	return strings.Join(rows, "\n")
}

func (m model) detailColumn() string {
	r, ok := m.selected()
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString(titleStyle.Render(r.name) + "\n")
	b.WriteString(dimStyle.Render("path:  ") + orDash(r.repoPath) + "\n")
	b.WriteString(dimStyle.Render("user:  ") + orDash(r.repoUser) + "\n")
	b.WriteString(dimStyle.Render("state: ") + stateLabel(r))
	b.WriteString("\n" + dimStyle.Render("watch: ") + watcherLabel(r))
	if r.lastRun.time != "" {
		b.WriteString("\n" + dimStyle.Render("last:  ") + formatLastRun(r.lastRun))
	}
	if len(r.queue) > 0 {
		b.WriteString("\n" + dimStyle.Render("queue:"))
		for _, j := range r.queue {
			b.WriteString("\n  • " + j)
		}
	}
	if s := m.staging; s.exists || len(s.worktrees) > 0 {
		b.WriteString("\n" + dimStyle.Render("stage: ") + stagingLabel(s))
		if len(s.worktrees) > 0 {
			b.WriteString("\n" + dimStyle.Render("build: ") +
				infoStyle.Render(strings.Join(s.worktrees, ", ")))
		}
	}
	if m.message != "" {
		b.WriteString("\n\n" + dimStyle.Render(m.message))
	}
	return b.String()
}

func (m model) activityPanel(maxLines int) string {
	if maxLines < 1 {
		return titleStyle.Render("activity")
	}
	lines := m.activity
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	body := dimStyle.Render("(no recent activity)")
	if len(lines) > 0 {
		body = dimStyle.Render(strings.Join(lines, "\n"))
	}
	return titleStyle.Render("activity") + "\n" + body
}

func (m model) listView() string {
	header := m.headerLine()
	footer := dimStyle.Render(footerKeys)

	// Before the first window-size message, render simply stacked.
	if m.width == 0 || m.height == 0 {
		out := header + "\n\n" + m.repoListColumn()
		if d := m.detailColumn(); d != "" {
			out += "\n\n" + d
		}
		return out + "\n\n" + footer
	}

	// list | detail at their NATURAL height, so the legend sits directly beneath the
	// panes. Columns clip only if a long list would push the chrome off-screen.
	var top string
	if m.width >= 70 { // wide enough to split; otherwise stack
		lw := clamp(m.width/3, 24, 40)
		colH := max(3, m.height-6)
		left := lipgloss.NewStyle().Width(lw).MaxHeight(colH).Render(m.repoListColumn())
		right := lipgloss.NewStyle().Width(m.width - lw).PaddingLeft(2).MaxHeight(colH).
			Render(m.detailColumn())
		top = lipgloss.JoinHorizontal(lipgloss.Top, left, right)
	} else {
		top = m.repoListColumn() + "\n\n" + m.detailColumn()
	}

	// Header, panes, legend (right under the panes), the activity log filling the
	// middle, then the commit heatmap pinned at the bottom.
	heat := m.heatmapCompact()
	overhead := lipgloss.Height(header) + lipgloss.Height(top) + lipgloss.Height(heat) + 7
	activityLines := clamp(m.height-overhead, 1, activityBuffer)
	return header + "\n\n" + top + "\n" + footer + "\n\n" +
		m.activityPanel(activityLines) + "\n\n" + heat
}

func tags(r repoStatus) []string {
	var t []string
	if r.running {
		t = append(t, okStyle.Render("● running"))
	}
	if r.paused {
		t = append(t, warnStyle.Render("⏸ paused"))
	}
	if !r.watcherOn {
		t = append(t, warnStyle.Render("⚠ watcher off"))
	}
	if n := len(r.queue); n > 0 {
		t = append(t, infoStyle.Render(fmt.Sprintf("%d queued", n)))
	}
	if strings.HasPrefix(r.lastRun.status, "failed") {
		t = append(t, errStyle.Render("✗ last run failed"))
	}
	return t
}

// formatLastRun renders the watcher's last-run record: colored status, the outcome
// line, and how long ago it ran.
func formatLastRun(s runStatus) string {
	var status string
	switch {
	case strings.HasPrefix(s.status, "ok"):
		status = okStyle.Render(s.status)
	case strings.HasPrefix(s.status, "failed"):
		status = errStyle.Render(s.status)
	default:
		status = s.status
	}
	parts := []string{status}
	if s.outcome != "" {
		parts = append(parts, s.outcome)
	}
	line := strings.Join(parts, " · ")
	if rel := relTime(s.time); rel != "" {
		line += " " + dimStyle.Render("("+rel+")")
	}
	return line
}

func relTime(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return ""
	}
	switch d := time.Since(t); {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours())/24)
	}
}

// stagingLabel renders the work branch's promote-readiness: clean (== base), or how far
// ahead (work waiting to promote) and behind (trailing base) it is.
func stagingLabel(s staging) string {
	if !s.exists {
		return dimStyle.Render("—")
	}
	if s.ahead == 0 && s.behind == 0 {
		return okStyle.Render("clean") + dimStyle.Render(" (= "+s.base+")")
	}
	var parts []string
	if s.ahead > 0 {
		parts = append(parts, infoStyle.Render(fmt.Sprintf("%d ahead", s.ahead)))
	}
	if s.behind > 0 {
		parts = append(parts, warnStyle.Render(fmt.Sprintf("%d behind", s.behind)))
	}
	return strings.Join(parts, " · ") + dimStyle.Render(" "+s.work+" vs "+s.base)
}

func stateLabel(r repoStatus) string {
	switch {
	case r.running:
		return okStyle.Render("running")
	case r.paused:
		return warnStyle.Render("paused")
	default:
		return "idle"
	}
}

func orDash(s string) string {
	if s == "" {
		return dimStyle.Render("(unset)")
	}
	return s
}

func main() {
	if _, err := tea.NewProgram(initialModel()).Run(); err != nil {
		fmt.Println("tui error:", err)
	}
}
