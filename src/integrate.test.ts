import { describe, expect, it, vi } from 'vitest'
import { type IntegrateDeps, integrate } from './integrate'

const tasks = (...ids: string[]) =>
	ids.map((id) => ({ id, branch: `auto/${id.toLowerCase()}` }))

/** Deps that merge cleanly and gate green unless overridden. */
function makeDeps(over: Partial<IntegrateDeps> = {}) {
	const calls: string[] = []
	const deps: IntegrateDeps = {
		mergeBranch: vi.fn(async (b: string) => {
			calls.push(`merge ${b}`)
			return 'merged' as const
		}),
		rollbackLastMerge: vi.fn(async () => {
			calls.push('rollback')
		}),
		runGates: vi.fn(async () => {
			calls.push('gates')
			return true
		}),
		park: vi.fn(async () => {}),
		recordBlocked: vi.fn(async (id: string) => {
			calls.push(`block ${id}`)
			return true
		}),
		pushStaging: vi.fn(async () => {
			calls.push('push')
			return true
		}),
		log: vi.fn(),
		...over,
	}
	return { deps, calls }
}

describe('integrate', () => {
	it('does nothing with no tasks and nothing blocked', async () => {
		const { deps, calls } = makeDeps()
		const out = await integrate([], [], deps)
		expect(out).toEqual({ staged: [], parked: [], blocked: [] })
		expect(calls).toEqual([])
	})

	it('persists an agent-blocked task and pushes even with no merges', async () => {
		const { deps, calls } = makeDeps()
		const out = await integrate([], ['TASK-66'], deps)
		expect(out).toEqual({ staged: [], parked: [], blocked: ['TASK-66'] })
		expect(calls).toEqual(['block TASK-66', 'push'])
		expect(deps.mergeBranch).not.toHaveBeenCalled()
	})

	it('does not count an already-recorded block (no-op) toward the push', async () => {
		const { deps } = makeDeps({ recordBlocked: vi.fn(async () => false) })
		const out = await integrate([], ['TASK-66'], deps)
		expect(out).toEqual({ staged: [], parked: [], blocked: [] })
		expect(deps.pushStaging).not.toHaveBeenCalled()
	})

	it('lands clean branches in order, gating after each merge', async () => {
		const { deps, calls } = makeDeps()
		const out = await integrate(tasks('TASK-1', 'TASK-2'), [], deps)
		expect(out).toEqual({
			staged: ['TASK-1', 'TASK-2'],
			parked: [],
			blocked: [],
		})
		expect(calls).toEqual([
			'merge auto/task-1',
			'gates',
			'merge auto/task-2',
			'gates',
			'push',
		])
		expect(deps.park).not.toHaveBeenCalled()
	})

	it('parks a textual conflict without rolling back and continues', async () => {
		const mergeBranch = vi.fn(async (b: string) =>
			b === 'auto/task-1' ? ('conflict' as const) : ('merged' as const),
		)
		const { deps } = makeDeps({ mergeBranch })
		const out = await integrate(tasks('TASK-1', 'TASK-2'), [], deps)
		expect(out).toEqual({ staged: ['TASK-2'], parked: ['TASK-1'], blocked: [] })
		expect(deps.pushStaging).toHaveBeenCalledOnce()
		expect(deps.rollbackLastMerge).not.toHaveBeenCalled() // abort handled in merge
		expect(deps.park).toHaveBeenCalledWith(
			'TASK-1',
			expect.stringContaining('conflict'),
		)
	})

	it('rolls back and parks when combined-tree gates go red', async () => {
		const runGates = vi
			.fn()
			.mockResolvedValueOnce(false) // TASK-1 turns staging red
			.mockResolvedValueOnce(true) // TASK-2 is fine on the rolled-back base
		const { deps } = makeDeps({ runGates })
		const out = await integrate(tasks('TASK-1', 'TASK-2'), [], deps)
		expect(out).toEqual({ staged: ['TASK-2'], parked: ['TASK-1'], blocked: [] })
		expect(deps.pushStaging).toHaveBeenCalledOnce()
		expect(deps.rollbackLastMerge).toHaveBeenCalledOnce()
		expect(deps.park).toHaveBeenCalledWith(
			'TASK-1',
			expect.stringContaining('gates red'),
		)
	})

	it('does not publish staging when every task parks', async () => {
		const { deps } = makeDeps({
			mergeBranch: vi.fn(async () => 'conflict' as const),
		})
		const out = await integrate(tasks('TASK-1'), [], deps)
		expect(out).toEqual({ staged: [], parked: ['TASK-1'], blocked: [] })
		expect(deps.pushStaging).not.toHaveBeenCalled()
	})

	it('throws when publishing staging fails', async () => {
		const { deps } = makeDeps({
			pushStaging: vi.fn(async () => false),
		})
		await expect(integrate(tasks('TASK-1'), [], deps)).rejects.toThrow(
			/publish/,
		)
	})
})
