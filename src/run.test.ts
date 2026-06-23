import { describe, expect, it, vi } from 'vitest'
import { type RunDeps, runLoop } from './run'
import type { RunOptions } from './types'

const COMPLETED = '{"type":"turn.completed"}'

const baseOpts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 2,
	workspace: '/repo',
}

function makeDeps(stdout: string) {
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
		log: () => {},
	}
	return { deps, spawnAgent, push, prompts }
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
})
