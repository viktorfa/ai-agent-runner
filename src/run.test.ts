import { describe, expect, it, vi } from 'vitest'
import { DRAIN_SAFETY_CAP, type RunDeps, runLoop } from './run'
import type { RunOptions } from './types'

const COMPLETED = '{"type":"turn.completed"}'

const baseOpts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 2,
	workspace: '/repo',
}

function makeDeps(stdout: string, hasReadyWork = vi.fn(async () => false)) {
	const prompts: string[] = []
	const spawnAgent = vi.fn(
		async (_bin: string, _argv: string[], prompt: string) => {
			prompts.push(prompt)
			return stdout
		},
	)
	const push = vi.fn(async () => true)
	const deps: RunDeps = {
		readPrompt: async () => 'BASE PROMPT',
		spawnAgent,
		push,
		hasReadyWork,
		log: () => {},
	}
	return { deps, spawnAgent, push, prompts, hasReadyWork }
}

describe('runLoop', () => {
	it('runs N iterations and pushes after each successful one', async () => {
		const { deps, spawnAgent, push } = makeDeps(COMPLETED)
		const outcomes = await runLoop(baseOpts, deps)
		expect(outcomes).toHaveLength(2)
		expect(spawnAgent).toHaveBeenCalledTimes(2)
		expect(push).toHaveBeenCalledTimes(2)
		expect(outcomes.every((o) => o.result.ok && o.pushed)).toBe(true)
	})

	it('injects the task directive into the piped prompt', async () => {
		const { deps, prompts } = makeDeps(COMPLETED)
		await runLoop({ ...baseOpts, iterations: 1, task: 'TASK-9' }, deps)
		expect(prompts[0]).toContain('TASK-9')
	})

	it('does not push when noPush is set', async () => {
		const { deps, push } = makeDeps(COMPLETED)
		await runLoop({ ...baseOpts, iterations: 1, noPush: true }, deps)
		expect(push).not.toHaveBeenCalled()
	})

	it('stops early and does not push on auth failure', async () => {
		const { deps, push } = makeDeps('{"error":"authentication_failed"}')
		const outcomes = await runLoop(
			{ ...baseOpts, assistant: 'claude', iterations: 3 },
			deps,
		)
		expect(outcomes).toHaveLength(1)
		expect(push).not.toHaveBeenCalled()
	})

	describe('drain', () => {
		it('runs until the board has no ready work', async () => {
			// ready, ready, then empty -> exactly two iterations
			const hasReadyWork = vi
				.fn<() => Promise<boolean>>()
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false)
			const { deps, spawnAgent, push } = makeDeps(COMPLETED, hasReadyWork)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(2)
			expect(spawnAgent).toHaveBeenCalledTimes(2)
			expect(push).toHaveBeenCalledTimes(2)
		})

		it('does nothing when the board is already empty', async () => {
			const { deps, spawnAgent } = makeDeps(COMPLETED)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(0)
			expect(spawnAgent).not.toHaveBeenCalled()
		})

		it('stops at the safety cap when work never clears', async () => {
			const { deps, spawnAgent } = makeDeps(
				COMPLETED,
				vi.fn(async () => true),
			)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(DRAIN_SAFETY_CAP)
			expect(spawnAgent).toHaveBeenCalledTimes(DRAIN_SAFETY_CAP)
		})

		it('stops on auth failure mid-drain', async () => {
			const { deps, push } = makeDeps(
				'{"error":"authentication_failed"}',
				vi.fn(async () => true),
			)
			const outcomes = await runLoop(
				{ ...baseOpts, assistant: 'claude', drain: true },
				deps,
			)
			expect(outcomes).toHaveLength(1)
			expect(push).not.toHaveBeenCalled()
		})
	})
})
