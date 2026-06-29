import { describe, expect, it, vi } from 'vitest'
import { type AgentConfig, defaultConfig } from './config'
import { type OrchestrateDeps, orchestrate } from './orchestrate'
import type { RunOptions } from './types'

const opts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 1,
	workspace: '/repo',
}

const COMPLETED = '{"type":"turn.completed"}'

const resetConfig = defaultConfig() // workBranchMode: 'reset'
const accumulateConfig: AgentConfig = {
	...defaultConfig(),
	workBranchMode: 'accumulate',
}

function makeDeps(overrides?: {
	unmerged?: number
	branchExists?: boolean
	mergeCode?: number
	ready?: number
}) {
	const gitCalls: string[][] = []
	const git = vi.fn(async (args: string[]) => {
		gitCalls.push(args)
		if (args[0] === 'rev-list') {
			return { code: 0, stdout: `${overrides?.unmerged ?? 0}\n` }
		}
		if (args[0] === 'rev-parse') {
			return { code: overrides?.branchExists === false ? 1 : 0, stdout: '' }
		}
		if (args[0] === 'merge' && args[1] === '--no-edit') {
			return { code: overrides?.mergeCode ?? 0, stdout: '' }
		}
		return { code: 0, stdout: '' }
	})
	const runSetup = vi.fn(async () => {})
	const push = vi.fn(async () => true)
	const spawnAgent = vi.fn(async () => COMPLETED)
	const deps: OrchestrateDeps = {
		readPrompt: async () => 'BASE',
		readTaskMeta: async () => null,
		spawnAgent,
		push,
		readyCount: async () => overrides?.ready ?? 1,
		parkStuckTask: async () => null,
		log: () => {},
		git,
		runSetup,
	}
	return { deps, gitCalls, runSetup, push, spawnAgent }
}

const RESET = ['checkout', '-f', '-B', 'auto/work', 'origin/master']
const MERGE = ['merge', '--no-edit', 'origin/master']

describe('orchestrate (reset mode)', () => {
	it('fetches, resets the work branch, runs setup, then the loop', async () => {
		const { deps, gitCalls, runSetup, spawnAgent } = makeDeps()
		await orchestrate(opts, resetConfig, deps)
		expect(gitCalls[0]).toEqual(['fetch', 'origin'])
		expect(gitCalls).toContainEqual(RESET)
		expect(runSetup).toHaveBeenCalledOnce()
		expect(spawnAgent).toHaveBeenCalledOnce()
	})

	it('refuses to reset when the work branch has unmerged commits', async () => {
		const { deps } = makeDeps({ unmerged: 3 })
		await expect(orchestrate(opts, resetConfig, deps)).rejects.toThrow(
			/not in/i,
		)
	})

	it('resets anyway with force', async () => {
		const { deps, gitCalls, runSetup } = makeDeps({ unmerged: 3 })
		await orchestrate(opts, resetConfig, deps, true)
		expect(gitCalls).toContainEqual(RESET)
		expect(runSetup).toHaveBeenCalledOnce()
	})
})

describe('orchestrate (accumulate mode)', () => {
	it('resumes the existing work branch, merges base, no guard', async () => {
		const { deps, gitCalls, runSetup, spawnAgent } = makeDeps({
			branchExists: true,
		})
		await orchestrate(opts, accumulateConfig, deps)
		expect(gitCalls).toContainEqual([
			'checkout',
			'-f',
			'-B',
			'auto/work',
			'origin/auto/work',
		])
		expect(gitCalls).toContainEqual(MERGE)
		expect(gitCalls.some((c) => c[0] === 'rev-list')).toBe(false) // no guard
		expect(runSetup).toHaveBeenCalledOnce()
		expect(spawnAgent).toHaveBeenCalledOnce()
	})

	it('creates the work branch from base when it does not exist', async () => {
		const { deps, gitCalls } = makeDeps({ branchExists: false })
		await orchestrate(opts, accumulateConfig, deps)
		expect(gitCalls).toContainEqual(RESET)
		expect(gitCalls).toContainEqual(MERGE)
	})

	it('aborts and throws on a merge conflict', async () => {
		const { deps, gitCalls, runSetup } = makeDeps({
			branchExists: true,
			mergeCode: 1,
		})
		await expect(orchestrate(opts, accumulateConfig, deps)).rejects.toThrow(
			/conflicts/i,
		)
		expect(gitCalls).toContainEqual(['merge', '--abort'])
		expect(runSetup).not.toHaveBeenCalled()
	})
})

describe('orchestrate (drain early-exit)', () => {
	it('skips setup and the agent when nothing is ready', async () => {
		const { deps, runSetup, spawnAgent } = makeDeps({ ready: 0 })
		const outcomes = await orchestrate(
			{ ...opts, drain: true },
			accumulateConfig,
			deps,
		)
		expect(outcomes).toHaveLength(0)
		expect(runSetup).not.toHaveBeenCalled()
		expect(spawnAgent).not.toHaveBeenCalled()
	})
})
