import type { TaskMeta } from './task'

/**
 * Picks which ready tasks an autonomous executor may start *right now* (see
 * docs/PARALLEL_AGENTS.md). It takes any ready task up to capacity — the same work the
 * sequential drain would — and only holds one back when:
 *
 * - it's explicitly `risk: needs-human` (the director's "I'll do this one myself" opt-out), or
 * - a blocker it depends on isn't Done yet, or
 * - it *declares* an area already leased by in-flight work.
 *
 * Area leases are an optional, opt-in conflict *prevention*: a task that names its areas
 * won't run beside overlapping work. A task with no declared areas just runs — if two such
 * tasks then touch the same files, the serialized integrator catches the conflict and
 * parks one for redo (docs/PARALLEL_AGENTS.md §5–6). So labelling buys fewer re-runs, not
 * permission to run.
 *
 * Pure: given the candidate tasks and what's in flight, return the subset to dispatch.
 * Selection, claiming, and worktrees live above this.
 */

export interface DispatchInput {
	/** Ready (To Do) tasks, highest priority first. */
	candidates: TaskMeta[]
	/** Areas currently leased by in-flight agents. */
	busyAreas: ReadonlySet<string>
	/** Ids of tasks not yet Done — a candidate blocked by any of these is held back. */
	pending: ReadonlySet<string>
	/** How many more agents may start now (the cap minus those already running). */
	capacity: number
}

/** A task's declared areas — its conflict lease. Empty (no declaration) = no lease, runs freely. */
const leaseOf = (t: TaskMeta): string[] => t.areas

function conflicts(lease: string[], held: Set<string>): boolean {
	return lease.some((area) => held.has(area))
}

export function selectDispatchable({
	candidates,
	busyAreas,
	pending,
	capacity,
}: DispatchInput): TaskMeta[] {
	const held = new Set<string>(busyAreas)
	const chosen: TaskMeta[] = []
	for (const task of candidates) {
		if (chosen.length >= capacity) break
		if (task.risk === 'needs-human') continue // explicit director opt-out stays off
		if (task.blockedBy.some((b) => pending.has(b))) continue // unmet dependency
		const lease = leaseOf(task)
		if (conflicts(lease, held)) continue // would collide with a declared in-flight area
		chosen.push(task)
		for (const area of lease) held.add(area)
	}
	return chosen
}
