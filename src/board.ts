/** Pure parsing of the Backlog board listing (`backlog task list --plain`). */

/**
 * Ready task ids — the `TASK-N` entries under the board's "To Do:" section, in
 * listing order (top first, i.e. the order the agent picks them). Other sections
 * (In Progress, Blocked, Done) are ignored: only To Do tasks are ready work.
 *
 * Pure on purpose — the IO layer reads the board and checks the command exit
 * code; this only interprets the text, so it stays unit-testable.
 */
export function parseReadyTaskIds(boardListing: string): string[] {
	const ids: string[] = []
	let inTodo = false
	for (const line of boardListing.split('\n')) {
		if (/^To Do:/.test(line)) {
			inTodo = true
			continue
		}
		if (!inTodo) continue
		// A new left-aligned "Header:" line ends the To Do section. Task lines are
		// indented, so they never match this.
		if (/^\S.*:\s*$/.test(line)) break
		const match = line.match(/\bTASK-\d+\b/i)
		if (match) ids.push(match[0].toUpperCase())
	}
	return ids
}
