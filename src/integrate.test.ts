import { describe, expect, it, vi } from 'vitest'
import { type IntegrateDeps, integrate } from './integrate'

const tasks = (...ids: string[]) =>
	ids.map((id) => ({ id, branch: `auto/${id.toLowerCase()}` }))

/** Deps that merge cleanly and gate green unless overridden. */
function makeDeps(over: Partial<IntegrateDeps> = {}) {
	const calls: string[] = []
	const deps: IntegrateDeps = {
		prepareStaging: vi.fn(async () => {
			calls.push('prepare')
		}),
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
		log: vi.fn(),
		...over,
	}
	return { deps, calls }
}

describe('integrate', () => {
	it('does nothing (not even prepare staging) with no tasks', async () => {
		const { deps } = makeDeps()
		const out = await integrate([], deps)
		expect(out).toEqual({ staged: [], parked: [] })
		expect(deps.prepareStaging).not.toHaveBeenCalled()
	})

	it('lands clean branches in order, gating after each merge', async () => {
		const { deps, calls } = makeDeps()
		const out = await integrate(tasks('TASK-1', 'TASK-2'), deps)
		expect(out).toEqual({ staged: ['TASK-1', 'TASK-2'], parked: [] })
		expect(calls).toEqual([
			'prepare',
			'merge auto/task-1',
			'gates',
			'merge auto/task-2',
			'gates',
		])
		expect(deps.park).not.toHaveBeenCalled()
	})

	it('parks a textual conflict without rolling back and continues', async () => {
		const mergeBranch = vi.fn(async (b: string) =>
			b === 'auto/task-1' ? ('conflict' as const) : ('merged' as const),
		)
		const { deps } = makeDeps({ mergeBranch })
		const out = await integrate(tasks('TASK-1', 'TASK-2'), deps)
		expect(out).toEqual({ staged: ['TASK-2'], parked: ['TASK-1'] })
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
		const out = await integrate(tasks('TASK-1', 'TASK-2'), deps)
		expect(out).toEqual({ staged: ['TASK-2'], parked: ['TASK-1'] })
		expect(deps.rollbackLastMerge).toHaveBeenCalledOnce()
		expect(deps.park).toHaveBeenCalledWith(
			'TASK-1',
			expect.stringContaining('gates red'),
		)
	})
})
