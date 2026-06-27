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
)

const chromeHeight = 4 // header + footer rows reserved around the viewport

type model struct {
	fleet      fleet
	cursor     int
	mode       viewMode
	vp         viewport.Model
	vpName     string // repo whose transcript the viewport shows
	vpUser     string
	vpPath     string
	roles      []string // role picker choices for the selected repo (modeEnqueue)
	roleCursor int
	width      int
	height     int
	message    string
}

func initialModel() model {
	return model{fleet: loadFleet(), vp: viewport.New()}
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
			m.refreshTranscript() // one sudo read for the viewed repo only
		case modeList:
			m.fleet = loadFleet()
		}
		// modeEnqueue: leave the fleet steady while the transient picker is open.
		return m, tick()
	case tea.KeyPressMsg:
		switch m.mode {
		case modeTranscript:
			return m.updateTranscript(msg)
		case modeEnqueue:
			return m.updateEnqueue(msg)
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
		}
	case "down", "j":
		if m.cursor < len(m.fleet.repos)-1 {
			m.cursor++
		}
	case "enter", "t":
		if r, ok := m.selected(); ok {
			m.openTranscript(r)
		}
	case "r":
		m.fleet = loadFleet()
		m.message = "refreshed"
	case "e":
		if r, ok := m.selected(); ok {
			m.roles = repoRoles(r.repoUser, r.repoPath)
			m.roleCursor = 0
			m.mode = modeEnqueue
		}
	case "p":
		if r, ok := m.selected(); ok {
			m.act("toggled pause for "+r.name, togglePause(m.fleet.configDir, r.name))
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
	case "enter":
		if r, ok := m.selected(); ok && m.roleCursor < len(m.roles) {
			role := m.roles[m.roleCursor]
			m.act("queued "+role+" for "+r.name, enqueue(m.fleet.configDir, r.name, "--loop", role))
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
}

func (m *model) openTranscript(r repoStatus) {
	m.mode = modeTranscript
	m.vpName, m.vpUser, m.vpPath = r.name, r.repoUser, r.repoPath
	m.vp.SetContent(transcriptOr(transcriptTail(r.repoUser, r.repoPath, 500), r.name))
	m.vp.GotoBottom()
}

// refreshTranscript re-reads the viewed transcript, following the tail only if the
// user is already at the bottom (so scrolling back up isn't yanked away).
func (m *model) refreshTranscript() {
	atBottom := m.vp.AtBottom()
	content := transcriptTail(m.vpUser, m.vpPath, 500)
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

func (m model) View() tea.View {
	var content string
	switch m.mode {
	case modeTranscript:
		content = m.transcriptView()
	case modeEnqueue:
		content = m.enqueueView()
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
	b.WriteString("\n" + dimStyle.Render("↑/↓ choose · enter queue · esc cancel"))
	return b.String()
}

func (m model) transcriptView() string {
	header := titleStyle.Render(m.vpName+" — transcript") + "  " +
		dimStyle.Render("(latest loop log, follows the tail)")
	footer := dimStyle.Render("↑/↓ pgup/pgdn scroll · esc/q back · refreshes every 3s")
	return header + "\n" + m.vp.View() + "\n" + footer
}

func (m model) listView() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("agent-runner") + "   ")
	if m.fleet.watcherActive {
		b.WriteString(okStyle.Render("watcher: active"))
	} else {
		b.WriteString(errStyle.Render("watcher: inactive"))
	}
	b.WriteString("\n\n")

	if len(m.fleet.repos) == 0 {
		b.WriteString(dimStyle.Render("no repos in "+m.fleet.configDir+"/repos/") + "\n")
	}
	for i, r := range m.fleet.repos {
		cursor := "  "
		name := r.name
		if i == m.cursor {
			cursor = selStyle.Render("> ")
			name = selStyle.Render(name)
		}
		b.WriteString(cursor + name + "  " + strings.Join(tags(r), " ") + "\n")
	}

	if r, ok := m.selected(); ok {
		b.WriteString("\n" + titleStyle.Render(r.name) + "\n")
		b.WriteString(dimStyle.Render("path:  ") + orDash(r.repoPath) + "\n")
		b.WriteString(dimStyle.Render("user:  ") + orDash(r.repoUser) + "\n")
		b.WriteString(dimStyle.Render("state: ") + stateLabel(r) + "\n")
		if r.lastRun.time != "" {
			b.WriteString(dimStyle.Render("last:  ") + formatLastRun(r.lastRun) + "\n")
		}
		if len(r.queue) > 0 {
			b.WriteString(dimStyle.Render("queue:") + "\n")
			for _, j := range r.queue {
				b.WriteString("  • " + j + "\n")
			}
		}
	}

	if m.message != "" {
		b.WriteString("\n" + dimStyle.Render(m.message) + "\n")
	}
	b.WriteString("\n" + dimStyle.Render(
		"↑/↓ move · enter/t transcript · e enqueue (pick role) · p pause · x clear queue · r refresh · q quit"))

	return b.String()
}

func tags(r repoStatus) []string {
	var t []string
	if r.running {
		t = append(t, okStyle.Render("● running"))
	}
	if r.paused {
		t = append(t, warnStyle.Render("⏸ paused"))
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
