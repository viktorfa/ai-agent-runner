// agent-runner TUI — an operator dashboard over the runner's existing files and
// commands. Read-only view of the registry, queue, pause flags, running drains and
// the watcher; actions only call the runner's own primitives. It changes nothing
// about the runner's functionality, state, or storage.
package main

import (
	"fmt"
	"strings"
	"time"

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

type model struct {
	fleet   fleet
	cursor  int
	message string
}

func initialModel() model {
	return model{fleet: loadFleet()}
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
	case tickMsg:
		m.fleet = loadFleet()
		return m, tick()
	case tea.KeyPressMsg:
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
		case "r":
			m.fleet = loadFleet()
			m.message = "refreshed"
		case "e":
			if r, ok := m.selected(); ok {
				m.act("queued steward for "+r.name, enqueue(m.fleet.configDir, r.name, "--loop", "steward"))
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
	}
	return m, nil
}

// act records the outcome of an action and refreshes the fleet view.
func (m *model) act(ok string, err error) {
	if err != nil {
		m.message = "error: " + err.Error()
	} else {
		m.message = ok
	}
	m.fleet = loadFleet()
}

func (m model) View() tea.View {
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
		"↑/↓ move · e enqueue steward · p toggle pause · x clear queue · r refresh · q quit"))

	v := tea.NewView(b.String())
	v.AltScreen = true // v2 controls the alt screen via the View, not a program option
	return v
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
	return t
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
	p := tea.NewProgram(initialModel())
	if _, err := p.Run(); err != nil {
		fmt.Println("tui error:", err)
	}
}
