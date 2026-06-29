import type { AgentConfig } from './config'
import { selectDispatchable } from './scheduler'
import type { TaskMeta } from './task'

/** Outcome of one task dispatched to its own worktree. */
export interface TaskOutcome {
	id: string
	ok: boolean
}

/** IO the parallel planner needs, injected so the dispatch logic is unit-testable. */
export interface ParallelDeps {
	/** Refresh origin's refs. */
	fetch(): Promise<void>
	/**
	 * Prepare the accumulating staging branch (auto/work) and leave the checkout on it,
	 * absorbing newly-filed tasks from origin/<base>. Everything downstream keys off this
	 * one branch: the board is read from it and each worktree is cut from it, so a
	 * dispatched task is one the agent will actually find, and a completed task (its Done
	 * recorded on staging) won't be re-dispatched. `master` advances only on `promote`.
	 */
	prepareStaging(): Promise<void>
	/** Ready (To Do) tasks with their parsed metadata, highest priority first. */
	readReadyTasks(): Promise<TaskMeta[]>
	/** Create the task's isolated worktree; resolve its workspace path. */
	addWorktree(taskId: string): Promise<string>
	/** Run the single task to completion in its worktree; resolve true on success. */
	runTask(input: { task: string; workspace: string }): Promise<boolean>
	/** Read the assigned task metadata from its worktree after the agent commits. */
	readTaskStatus(input: {
		task: string
		workspace: string
	}): Promise<string | undefined>
	/** Tear down the task's worktree — its branch persists for the integrator. */
	removeWorktree(taskId: string): Promise<void>
	log(line: string): void
}

/**
 * Dispatch up to `maxParallel` ready tasks concurrently (capacity 1 is just the
 * sequential drain) — each in its own git worktree cut from the prepared staging branch
 * (docs/PARALLEL_AGENTS.md). The scheduler takes any ready task — skipping only an
 * explicit `needs-human` opt-out or an unmet blocker — and applies area leases only where
 * tasks declare them; each task is isolated so one failing or slow run never blocks the
 * others. The branches are left for the integrator to fold back into staging (which is
 * what catches conflicts between tasks that didn't declare disjoint areas).
 *
 * One planning pass = one watcher poll: work held back this round (a blocker not yet
 * Done, or an overlapping declared area) is picked up on a later poll once it frees.
 */
export async function runParallel(
	config: AgentConfig,
	deps: ParallelDeps,
): Promise<TaskOutcome[]> {
	await deps.fetch()
	await deps.prepareStaging()
	const candidates = await deps.readReadyTasks()
	// A candidate blocked by another still-pending task waits. We only see the ready
	// set here, so this catches a blocker that is itself ready; an in-progress blocker
	// is caught later by the integrator's combined-tree gates.
	const pending = new Set(candidates.map((t) => t.id))
	const chosen = selectDispatchable({
		candidates,
		busyAreas: new Set(),
		pending,
		capacity: config.maxParallel,
	})
	if (chosen.length === 0) {
		deps.log('no ready tasks to dispatch')
		return []
	}
	deps.log(
		`dispatching ${chosen.length} task(s) in parallel: ${chosen
			.map((t) => t.id)
			.join(', ')}`,
	)
	return Promise.all(chosen.map((t) => dispatchOne(t.id, deps)))
}

async function dispatchOne(
	id: string,
	deps: ParallelDeps,
): Promise<TaskOutcome> {
	let workspace: string
	try {
		workspace = await deps.addWorktree(id)
	} catch (err) {
		deps.log(`worktree add failed for ${id}: ${errText(err)}`)
		return { id, ok: false }
	}
	try {
		if (!(await deps.runTask({ task: id, workspace }))) {
			return { id, ok: false }
		}
		const status = await deps.readTaskStatus({ task: id, workspace })
		if (status !== 'Done') {
			deps.log(
				`task ${id} finished but status is ${status ?? 'unknown'}; ` +
					'not integrating branch',
			)
			return { id, ok: false }
		}
		return { id, ok: true }
	} catch (err) {
		deps.log(`task ${id} threw: ${errText(err)}`)
		return { id, ok: false }
	} finally {
		try {
			await deps.removeWorktree(id)
		} catch (err) {
			deps.log(`worktree cleanup failed for ${id}: ${errText(err)}`)
		}
	}
}

const errText = (err: unknown): string =>
	err instanceof Error ? err.message : String(err)
