import { describe, expect, it } from 'vitest'
import { resolveConfig } from './config'
import { makeDeps } from './io'
import type { RunOptions } from './types'

const opts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 1,
	workspace: process.cwd(),
}

describe('spawnAgent idle watchdog', () => {
	it('kills an agent that produces no output within the idle timeout', async () => {
		const deps = makeDeps(opts, resolveConfig({ agentIdleTimeoutSec: 0.3 }))
		const start = Date.now()
		const out = await deps.spawnAgent('sleep', ['30'], '')
		// Killed at ~300ms by the watchdog, not after the full 30s sleep.
		expect(Date.now() - start).toBeLessThan(3000)
		expect(out).toBe('') // nothing emitted before the kill
	})

	it('lets an agent that finishes before the timeout run to completion', async () => {
		const deps = makeDeps(opts, resolveConfig({ agentIdleTimeoutSec: 5 }))
		const out = await deps.spawnAgent('printf', ['hello'], '')
		expect(out).toBe('hello')
	})
})
