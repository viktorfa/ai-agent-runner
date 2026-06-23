import { describe, expect, it } from 'vitest'
import type { RunOptions } from '../types'
import { claudeAdapter } from './claude'

const baseOpts: RunOptions = {
	assistant: 'claude',
	role: 'dev',
	iterations: 1,
	workspace: '/repo',
}

describe('claudeAdapter.buildArgv', () => {
	it('runs headless with the stream-json output format', () => {
		const argv = claudeAdapter.buildArgv(baseOpts)
		expect(argv).toContain('-p')
		expect(argv).toContain('--output-format=stream-json')
	})

	it('passes model and effort when set', () => {
		const argv = claudeAdapter.buildArgv({
			...baseOpts,
			model: 'claude-x',
			effort: 'high',
		})
		expect(argv[argv.indexOf('--model') + 1]).toBe('claude-x')
		expect(argv).toContain('--effort')
	})
})

describe('claudeAdapter.parseResult', () => {
	it('flags authentication failure', () => {
		const r = claudeAdapter.parseResult('{"error":"authentication_failed"}')
		expect(r.ok).toBe(false)
		expect(r.authFailed).toBe(true)
	})

	it('returns ok with the final result summary', () => {
		const r = claudeAdapter.parseResult('{"type":"result","result":"all done"}')
		expect(r.ok).toBe(true)
		expect(r.summary).toBe('all done')
	})
})
