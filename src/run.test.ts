import { describe, expect, it, vi } from 'vitest'
import {
	AGENT_FAILURE_LIMIT,
	DRAIN_SAFETY_CAP,
	DRAIN_STALL_LIMIT,
	type RunDeps,
	runLoop,
} from './run'
import type { RunOptions } from './types'

const COMPLETED = '{"type":"turn.completed"}'

const baseOpts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 2,
	workspace: '/repo',
}

function makeDeps(stdout: string, readyCount = vi.fn(async () => 0)) {
	const prompts: string[] = []
	const spawnAgent = vi.fn(
		async (_bin: string, _argv: string[], prompt: string) => {
			prompts.push(prompt)
			return stdout
		},
	)
	const push = vi.fn(async () => true)
	const parkStuckTask = vi.fn(async () => 'TASK-STUCK' as string | null)
	const deps: RunDeps = {
		readPrompt: async () => 'BASE PROMPT',
		spawnAgent,
		push,
		readyCount,
		parkStuckTask,
		log: () => {},
	}
	return { deps, spawnAgent, push, prompts, readyCount, parkStuckTask }
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
			// before/after counts per iteration: [2,1] then [1,0], then before=0 -> stop
			const readyCount = vi
				.fn<() => Promise<number>>()
				.mockResolvedValueOnce(2)
				.mockResolvedValueOnce(1)
				.mockResolvedValueOnce(1)
				.mockResolvedValueOnce(0)
				.mockResolvedValue(0)
			const { deps, spawnAgent, push } = makeDeps(COMPLETED, readyCount)
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

		it('parks the stuck task and stops after DRAIN_STALL_LIMIT no-progress iterations', async () => {
			// agent runs cleanly (turn.completed) but the count never drops
			const { deps, spawnAgent, parkStuckTask } = makeDeps(
				COMPLETED,
				vi.fn(async () => 3),
			)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(DRAIN_STALL_LIMIT)
			expect(spawnAgent).toHaveBeenCalledTimes(DRAIN_STALL_LIMIT)
			expect(parkStuckTask).toHaveBeenCalledTimes(1)
		})

		it('stops on repeated agent failure without parking a task', async () => {
			// no turn.completed -> result.ok is false (agent error, not a bad task)
			const { deps, spawnAgent, push, parkStuckTask } = makeDeps(
				'{"type":"item.completed"}',
				vi.fn(async () => 3),
			)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(AGENT_FAILURE_LIMIT)
			expect(spawnAgent).toHaveBeenCalledTimes(AGENT_FAILURE_LIMIT)
			expect(parkStuckTask).not.toHaveBeenCalled()
			expect(push).not.toHaveBeenCalled()
			// every iteration failed -> the run reports failure (non-zero exit)
			expect(outcomes.every((o) => !o.result.ok)).toBe(true)
		})

		it('stops at the safety cap under steady progress', async () => {
			// strictly decreasing but never reaching 0 within the cap
			let n = 1000
			const { deps, spawnAgent } = makeDeps(
				COMPLETED,
				vi.fn(async () => n--),
			)
			const outcomes = await runLoop({ ...baseOpts, drain: true }, deps)
			expect(outcomes).toHaveLength(DRAIN_SAFETY_CAP)
			expect(spawnAgent).toHaveBeenCalledTimes(DRAIN_SAFETY_CAP)
		})

		it('stops on auth failure mid-drain', async () => {
			const { deps, push } = makeDeps(
				'{"error":"authentication_failed"}',
				vi.fn(async () => 3),
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
