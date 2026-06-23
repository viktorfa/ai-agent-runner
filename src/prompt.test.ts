import { describe, expect, it } from 'vitest'
import { assemblePrompt } from './prompt'

describe('assemblePrompt', () => {
	it('returns the base prompt unchanged with no task', () => {
		expect(assemblePrompt('BASE')).toBe('BASE')
	})

	it('appends an explicit assignment directive for a task', () => {
		const out = assemblePrompt('BASE', 'TASK-12')
		expect(out).toContain('BASE')
		expect(out).toContain('TASK-12')
		expect(out.toLowerCase()).toContain('only')
	})
})
