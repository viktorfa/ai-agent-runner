import { describe, expect, it } from 'vitest'
import { assemblePrompt } from './prompt'
import type { TaskMeta } from './task'

const meta = (over: Partial<TaskMeta> = {}): TaskMeta => ({
	id: 'TASK-12',
	labels: [],
	blockedBy: [],
	documentation: [],
	areas: [],
	acceptanceCriteria: [],
	...over,
})

describe('assemblePrompt', () => {
	it('returns the base prompt unchanged with no task', () => {
		expect(assemblePrompt({ base: 'BASE' })).toBe('BASE')
	})

	it('appends an explicit assignment directive for a task', () => {
		const out = assemblePrompt({ base: 'BASE', task: 'TASK-12' })
		expect(out).toContain('BASE')
		expect(out).toContain('TASK-12')
		expect(out.toLowerCase()).toContain('only')
	})

	it('folds open acceptance criteria and docs into the brief', () => {
		const out = assemblePrompt({
			base: 'BASE',
			task: 'TASK-12',
			meta: meta({
				acceptanceCriteria: [
					{ text: 'first thing', done: false },
					{ text: 'already done', done: true },
				],
				documentation: ['docs/GROUND_TRUTH.md'],
			}),
		})
		expect(out).toContain('first thing')
		expect(out).not.toContain('already done') // satisfied criteria are omitted
		expect(out).toContain('docs/GROUND_TRUTH.md')
	})
})
