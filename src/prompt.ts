import type { TaskMeta } from './task'

const ASSIGNMENT_HEADER = "## This run's assignment (overrides board selection)"

export interface AssembleInput {
	/** The role's base prompt. */
	base: string
	/** When set, the agent works only this task (overrides board self-selection). */
	task?: string
	/** Metadata for `task` — folds its open acceptance criteria + docs into the brief. */
	meta?: TaskMeta | null
}

/**
 * Compose the prompt piped to the agent. With no task, the agent selects from the
 * board itself (per the prompt's own rules). With a task, an explicit assignment
 * directive overrides that selection — and, when its metadata is available, a brief:
 * the open acceptance criteria to satisfy and the docs the task points at (its ground
 * truth). No board mutation needed.
 */
export function assemblePrompt({ base, task, meta }: AssembleInput): string {
	if (!task) return base
	const brief = [
		`Work ONLY on ${task}. Claim it, take it through verification and commit, and ` +
			'do not pick any other task or scan the board. If it is blocked or already ' +
			'Done, stop and report.',
	]
	const open = meta?.acceptanceCriteria.filter((c) => !c.done) ?? []
	if (open.length > 0) {
		brief.push('', 'Done means every acceptance criterion holds:')
		for (const c of open) brief.push(`- ${c.text}`)
	}
	if (meta && meta.documentation.length > 0) {
		brief.push(
			'',
			`Read first — these are the ground truth for this task: ${meta.documentation.join(', ')}.`,
		)
	}
	return `${base}\n\n${ASSIGNMENT_HEADER}\n${brief.join('\n')}\n`
}
