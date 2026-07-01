import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from './config'
import { type ParallelDeps, runParallel } from './parallel'
import type { TaskMeta } from './task'

// Distinct area per task by default, so the lease scheduler never serializes them and
// capacity is what governs — area-overlap behaviour is covered in scheduler.test.ts.
const task = (id: string, over: Partial<TaskMeta> = {}): TaskMeta => ({
	id,
	labels: [],
	blockedBy: [],
	documentation: [],
	areas: [id],
	acceptanceCriteria: [],
	risk: 'low',
	...over,
})

function makeDeps(ready: TaskMeta[], over: Partial<ParallelDeps> = {}) {
	const added: string[] = []
	const ran: string[] = []
	const deps: ParallelDeps = {
		fetch: vi.fn(async () => {}),
		prepareStaging: vi.fn(async () => {}),
		readReadyTasks: vi.fn(async () => ready),
		addWorktree: vi.fn(async (id: string) => {
			added.push(id)
			return `/w/.worktrees/${id}`
		}),
		runTask: vi.fn(async ({ task: t }) => {
			ran.push(t)
			return true
		}),
		readTaskStatus: vi.fn(async () => 'Done'),
		removeWorktree: vi.fn(async () => {}),
		log: vi.fn(),
		...over,
	}
	return { deps, added, ran }
}

describe('runParallel', () => {
	it('fetches, dispatches the scheduled tasks each in a worktree, then cleans up', async () => {
		const { deps, added, ran } = makeDeps([task('A'), task('B')])
		const out = await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(out).toEqual([
			{ id: 'A', ok: true, status: 'Done' },
			{ id: 'B', ok: true, status: 'Done' },
		])
		expect(deps.fetch).toHaveBeenCalledOnce()
		expect(added).toEqual(['A', 'B'])
		expect(ran.sort()).toEqual(['A', 'B'])
		expect(deps.removeWorktree).toHaveBeenCalledTimes(2)
	})

	it('caps concurrency at maxParallel', async () => {
		const { deps, ran } = makeDeps([task('A'), task('B'), task('C')])
		await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(ran.sort()).toEqual(['A', 'B'])
	})

	it('dispatches nothing when no task is dispatchable', async () => {
		const { deps, added } = makeDeps([task('A', { risk: 'needs-human' })])
		const out = await runParallel({ ...defaultConfig(), maxParallel: 3 }, deps)
		expect(out).toEqual([])
		expect(added).toEqual([])
	})

	it('isolates a failing task and still removes its worktree', async () => {
		const runTask = vi.fn(async ({ task: t }: { task: string }) => {
			if (t === 'A') throw new Error('boom')
			return true
		})
		const { deps } = makeDeps([task('A'), task('B')], { runTask })
		const out = await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(out).toContainEqual({ id: 'A', ok: false })
		expect(out).toContainEqual({ id: 'B', ok: true, status: 'Done' })
		expect(deps.removeWorktree).toHaveBeenCalledTimes(2) // cleanup ran for both
	})

	it('does not integrate a branch whose assigned task is still ready', async () => {
		const readTaskStatus = vi.fn(async () => 'To Do')
		const { deps } = makeDeps([task('A')], { readTaskStatus })
		const out = await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(out).toEqual([{ id: 'A', ok: false, status: 'To Do' }])
		expect(deps.log).toHaveBeenCalledWith(
			expect.stringContaining('status is To Do'),
		)
	})

	it('does not integrate blocked or unknown-status branches', async () => {
		const readTaskStatus = vi
			.fn()
			.mockResolvedValueOnce('Blocked')
			.mockResolvedValueOnce(undefined)
		const { deps } = makeDeps([task('A'), task('B')], { readTaskStatus })
		const out = await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(out).toContainEqual({ id: 'A', ok: false, status: 'Blocked' })
		expect(out).toContainEqual({ id: 'B', ok: false })
	})

	it('reports ok:false and skips the run when the worktree cannot be created', async () => {
		const addWorktree = vi.fn(async () => {
			throw new Error('worktree exists')
		})
		const runTask = vi.fn(async () => true)
		const { deps } = makeDeps([task('A')], { addWorktree, runTask })
		const out = await runParallel({ ...defaultConfig(), maxParallel: 2 }, deps)
		expect(out).toEqual([{ id: 'A', ok: false }])
		expect(runTask).not.toHaveBeenCalled()
		expect(deps.removeWorktree).not.toHaveBeenCalled() // nothing to tear down
	})
})
