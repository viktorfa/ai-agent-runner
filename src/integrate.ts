/** A task whose branch is ready to be folded into staging. */
export interface IntegrableTask {
	id: string
	/** The branch the agent built (auto/<id>). */
	branch: string
}

/** What landed where after an integration pass. */
export interface IntegrationResult {
	/** Task ids merged green into staging, in landing order. */
	staged: string[]
	/** Task ids held back (textual conflict or red combined-tree gates). */
	parked: string[]
}

/** IO the integrator needs, injected so the merge policy is unit-testable. */
export interface IntegrateDeps {
	/** Put staging (auto/work) at a clean base before any merge. */
	prepareStaging(): Promise<void>
	/**
	 * Merge a task branch into staging. `merged` leaves it applied; `conflict`
	 * means git couldn't auto-merge and the attempt was aborted, so staging is
	 * back at its pre-merge state.
	 */
	mergeBranch(branch: string): Promise<'merged' | 'conflict'>
	/** Undo the most recent successful merge, restoring staging to before it. */
	rollbackLastMerge(): Promise<void>
	/** Run the full gates on the current staging tree; true iff green. */
	runGates(): Promise<boolean>
	/** Hold a task back for human/redo attention, with a reason. */
	park(taskId: string, reason: string): Promise<void>
	log(line: string): void
}

/**
 * Fold each task branch into staging one at a time, re-running the full gates on the
 * COMBINED tree after every merge (docs/PARALLEL_AGENTS.md §5). This single-flight
 * pass is what catches *semantic* conflicts git sees no marker for — branch A renames
 * a symbol, branch B (green in isolation) still calls it. Staging is never left red:
 *
 * - a textual conflict → the merge is aborted and the task parked;
 * - red combined-tree gates → the merge is rolled back and the task parked.
 *
 * Parked tasks need a redo on the fresh base (a new dispatch off the updated staging);
 * we surface them rather than blind-resolving markers, which yields frankenmerges that
 * can pass tests yet be semantically wrong.
 */
export async function integrate(
	tasks: IntegrableTask[],
	deps: IntegrateDeps,
): Promise<IntegrationResult> {
	const staged: string[] = []
	const parked: string[] = []
	if (tasks.length === 0) return { staged, parked }

	await deps.prepareStaging()
	for (const { id, branch } of tasks) {
		if ((await deps.mergeBranch(branch)) === 'conflict') {
			deps.log(`parked ${id}: textual conflict merging ${branch} into staging`)
			await deps.park(id, 'textual conflict with staging — redo on fresh base')
			parked.push(id)
			continue
		}
		if (!(await deps.runGates())) {
			await deps.rollbackLastMerge()
			deps.log(`parked ${id}: combined-tree gates red after merging ${branch}`)
			await deps.park(id, 'combined-tree gates red — redo on fresh base')
			parked.push(id)
			continue
		}
		deps.log(`staged ${id} (${branch})`)
		staged.push(id)
	}
	return { staged, parked }
}
