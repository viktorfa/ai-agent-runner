import type { TaskMeta } from './task'

/**
 * Picks which ready tasks an autonomous executor may start *right now*, applying the
 * parallel-agents rules (docs/PARALLEL_AGENTS.md): only `risk: low` tasks, never one
 * with an unmet blocker, and never two whose areas overlap. Area leases *prevent*
 * conflicts (run disjoint work concurrently) rather than resolving them afterwards.
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

/** Sentinel lease for a task with no declared areas: an unknown footprint conflicts with all. */
const WILDCARD = '*'

const leaseOf = (t: TaskMeta): string[] =>
	t.areas.length > 0 ? t.areas : [WILDCARD]

function conflicts(lease: string[], held: Set<string>): boolean {
	if (held.has(WILDCARD)) return true // an unknown-footprint task already holds everything
	if (lease.includes(WILDCARD)) return held.size > 0 // unknown footprint needs exclusivity
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
		if (task.risk !== 'low') continue // conservative: needs-human / unspecified stay off
		if (task.blockedBy.some((b) => pending.has(b))) continue // unmet dependency
		const lease = leaseOf(task)
		if (conflicts(lease, held)) continue // would collide with in-flight or already-chosen work
		chosen.push(task)
		for (const area of lease) held.add(area)
	}
	return chosen
}
