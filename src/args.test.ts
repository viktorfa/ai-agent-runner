import { describe, expect, it } from 'vitest'
import { parseArgs } from './args'

describe('parseArgs', () => {
	it('uses sensible defaults', () => {
		const a = parseArgs([])
		expect(a.assistant).toBe('claude')
		expect(a.role).toBe('dev')
		expect(a.backend).toBe('docker')
		expect(a.iterations).toBe(1)
		expect(a.workspace).toBe('.')
		expect(a.noPush).toBe(false)
		expect(a.task).toBeUndefined()
	})

	it('parses a full host run', () => {
		const a = parseArgs([
			'--assistant',
			'codex',
			'--loop',
			'dev',
			'--backend',
			'host',
			'--proxy',
			'http://127.0.0.1:3128',
			'--task',
			'TASK-12',
			'--iterations',
			'2',
			'--workspace',
			'/repo',
			'--no-push',
		])
		expect(a.assistant).toBe('codex')
		expect(a.backend).toBe('host')
		expect(a.proxy).toBe('http://127.0.0.1:3128')
		expect(a.task).toBe('TASK-12')
		expect(a.iterations).toBe(2)
		expect(a.workspace).toBe('/repo')
		expect(a.noPush).toBe(true)
	})

	it('rejects an unknown assistant', () => {
		expect(() => parseArgs(['--assistant', 'gpt'])).toThrow(/assistant/)
	})

	it('rejects an unknown flag', () => {
		expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/)
	})

	it('throws on a flag missing its value', () => {
		expect(() => parseArgs(['--task'])).toThrow(/missing value/)
	})
})
