const ASSIGNMENT_HEADER = "## This run's assignment (overrides board selection)"

/**
 * Compose the prompt piped to the agent. With no task, the agent selects from
 * the board itself (per the prompt's own rules). With a task, an explicit
 * assignment directive overrides that selection — no board mutation needed.
 */
export function assemblePrompt(base: string, task?: string): string {
	if (!task) return base
	const directive =
		`Work ONLY on ${task}. Claim it, take it through verification and ` +
		'commit, and do not pick any other task or scan the board. If it is ' +
		'blocked or already Done, stop and report.'
	return `${base}\n\n${ASSIGNMENT_HEADER}\n${directive}\n`
}
