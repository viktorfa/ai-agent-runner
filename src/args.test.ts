import { describe, expect, it } from 'vitest'
import { parseArgs, resolveRunOptions } from './args'
import { defaultConfig } from './config'

describe('parseArgs', () => {
	it('uses sensible defaults; assistant/role unset (resolved from config)', () => {
		const a = parseArgs([])
		expect(a.assistant).toBeUndefined()
		expect(a.role).toBeUndefined()
		expect(a.iterations).toBe(1)
		expect(a.workspace).toBe('.')
		expect(a.drain).toBe(false)
		expect(a.noPush).toBe(false)
		expect(a.task).toBeUndefined()
	})

	it('parses a full run', () => {
		const a = parseArgs([
			'--assistant',
			'codex',
			'--loop',
			'dev',
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
		expect(a.proxy).toBe('http://127.0.0.1:3128')
		expect(a.task).toBe('TASK-12')
		expect(a.iterations).toBe(2)
		expect(a.workspace).toBe('/repo')
		expect(a.noPush).toBe(true)
	})

	it('parses --drain and defaults it off', () => {
		expect(parseArgs([]).drain).toBe(false)
		expect(parseArgs(['--drain']).drain).toBe(true)
	})

	it('rejects --task together with --drain', () => {
		expect(() => parseArgs(['--task', 'TASK-1', '--drain'])).toThrow(
			/mutually exclusive/,
		)
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

describe('resolveRunOptions', () => {
	const config = { ...defaultConfig(), assistant: 'codex' as const }

	it('falls back to the repo config when flags are absent', () => {
		const o = resolveRunOptions(parseArgs([]), {
			...config,
			model: 'gpt-x',
			effort: 'high',
		})
		expect(o.assistant).toBe('codex') // from config
		expect(o.role).toBe('dev') // per-dispatch default
		expect(o.model).toBe('gpt-x')
		expect(o.effort).toBe('high')
	})

	it('CLI flags override the repo config', () => {
		const o = resolveRunOptions(
			parseArgs(['--assistant', 'claude', '--loop', 'qa', '--model', 'opus']),
			{ ...config, model: 'gpt-x' },
		)
		expect(o.assistant).toBe('claude')
		expect(o.role).toBe('qa')
		expect(o.model).toBe('opus')
	})

	it('omits model/effort when neither flag nor config sets them', () => {
		const o = resolveRunOptions(parseArgs([]), config)
		expect(o.model).toBeUndefined()
		expect(o.effort).toBeUndefined()
	})
})
