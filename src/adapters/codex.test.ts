import { describe, expect, it } from 'vitest'
import type { RunOptions } from '../types'
import { codexAdapter } from './codex'

const baseOpts: RunOptions = {
	assistant: 'codex',
	role: 'dev',
	iterations: 1,
	workspace: '/home/agent/repos/plantegner',
}

describe('codexAdapter.buildArgv', () => {
	it('targets the real workspace via -C, never a hardcoded /workspace', () => {
		const argv = codexAdapter.buildArgv(baseOpts)
		const i = argv.indexOf('-C')
		expect(i).toBeGreaterThanOrEqual(0)
		expect(argv[i + 1]).toBe('/home/agent/repos/plantegner')
		expect(argv).not.toContain('/workspace')
	})

	it('maps effort to model_reasoning_effort', () => {
		const argv = codexAdapter.buildArgv({ ...baseOpts, effort: 'high' })
		expect(argv).toContain('model_reasoning_effort="high"')
	})

	it('omits model and effort when unset', () => {
		const argv = codexAdapter.buildArgv(baseOpts)
		expect(argv).not.toContain('--model')
		expect(argv.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
	})
})

describe('codexAdapter.parseResult', () => {
	it('is ok with a summary on a completed turn', () => {
		const stdout = [
			'{"type":"turn.started"}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"did the thing"}}',
			'{"type":"turn.completed"}',
		].join('\n')
		const r = codexAdapter.parseResult(stdout)
		expect(r.ok).toBe(true)
		expect(r.summary).toBe('did the thing')
	})

	it('is not ok when the turn never completes (e.g. proxy 403)', () => {
		const stdout = [
			'2026-01-01T00:00:00Z ERROR codex_api: proxy 403',
			'{"type":"turn.started"}',
		].join('\n')
		expect(codexAdapter.parseResult(stdout).ok).toBe(false)
	})
})
