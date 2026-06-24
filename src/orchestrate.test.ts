import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from './config'
import { type OrchestrateDeps, orchestrate } from './orchestrate'
import type { RunOptions } from './types'

const opts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 1,
	workspace: '/repo',
}

const COMPLETED = '{"type":"turn.completed"}'

function makeDeps(overrides?: { unmerged?: number }) {
	const gitCalls: string[][] = []
	const git = vi.fn(async (args: string[]) => {
		gitCalls.push(args)
		if (args[0] === 'rev-list') {
			return { code: 0, stdout: `${overrides?.unmerged ?? 0}\n` }
		}
		return { code: 0, stdout: '' }
	})
	const runSetup = vi.fn(async () => {})
	const push = vi.fn(async () => true)
	const spawnAgent = vi.fn(async () => COMPLETED)
	const deps: OrchestrateDeps = {
		readPrompt: async () => 'BASE',
		spawnAgent,
		push,
		hasReadyWork: async () => false,
		log: () => {},
		git,
		runSetup,
	}
	return { deps, gitCalls, runSetup, push, spawnAgent }
}

const RESET = ['checkout', '-B', 'auto/work', 'origin/master']

describe('orchestrate', () => {
	it('fetches, resets the work branch, runs setup, then the loop', async () => {
		const { deps, gitCalls, runSetup, spawnAgent } = makeDeps()
		await orchestrate(opts, defaultConfig(), deps)
		expect(gitCalls[0]).toEqual(['fetch', 'origin'])
		expect(gitCalls).toContainEqual(RESET)
		expect(runSetup).toHaveBeenCalledOnce()
		expect(spawnAgent).toHaveBeenCalledOnce()
	})

	it('refuses to reset when the work branch has unmerged commits', async () => {
		const { deps } = makeDeps({ unmerged: 3 })
		await expect(orchestrate(opts, defaultConfig(), deps)).rejects.toThrow(
			/not in/i,
		)
	})

	it('resets anyway with force', async () => {
		const { deps, gitCalls, runSetup } = makeDeps({ unmerged: 3 })
		await orchestrate(opts, defaultConfig(), deps, true)
		expect(gitCalls).toContainEqual(RESET)
		expect(runSetup).toHaveBeenCalledOnce()
	})
})
