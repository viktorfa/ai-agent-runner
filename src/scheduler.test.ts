import { describe, expect, it } from 'vitest'
import { selectDispatchable } from './scheduler'
import type { TaskMeta } from './task'

const task = (id: string, over: Partial<TaskMeta> = {}): TaskMeta => ({
	id,
	labels: [],
	blockedBy: [],
	documentation: [],
	areas: [],
	acceptanceCriteria: [],
	risk: 'low',
	...over,
})

const ids = (ts: TaskMeta[]): string[] => ts.map((t) => t.id)
const none: ReadonlySet<string> = new Set()

describe('selectDispatchable', () => {
	it('dispatches ready tasks up to capacity', () => {
		const out = selectDispatchable({
			candidates: [task('A'), task('B'), task('C')],
			busyAreas: none,
			pending: none,
			capacity: 2,
		})
		expect(ids(out)).toEqual(['A', 'B'])
	})

	it('takes unlabeled tasks (no risk, no area) concurrently', () => {
		// The common case: a board whose tasks declare neither risk nor area still
		// parallelizes — labelling is not a prerequisite for dispatch.
		const out = selectDispatchable({
			candidates: [
				task('A', { risk: undefined, areas: [] }),
				task('B', { risk: undefined, areas: [] }),
				task('C', { risk: undefined, areas: [] }),
			],
			busyAreas: none,
			pending: none,
			capacity: 3,
		})
		expect(ids(out)).toEqual(['A', 'B', 'C'])
	})

	it('holds back only an explicit needs-human task', () => {
		const out = selectDispatchable({
			candidates: [
				task('A', { risk: 'needs-human' }),
				task('B', { risk: undefined }),
				task('C', { risk: 'low' }),
			],
			busyAreas: none,
			pending: none,
			capacity: 5,
		})
		expect(ids(out)).toEqual(['B', 'C']) // needs-human stays off; the rest run
	})

	it('serializes tasks whose DECLARED areas overlap each other or in-flight work', () => {
		expect(
			ids(
				selectDispatchable({
					candidates: [
						task('A', { areas: ['x'] }),
						task('B', { areas: ['x'] }),
					],
					busyAreas: none,
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['A']) // B overlaps A's declared lease

		expect(
			ids(
				selectDispatchable({
					candidates: [task('A', { areas: ['x'] })],
					busyAreas: new Set(['x']),
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual([]) // x already leased by an in-flight agent
	})

	it('does not let a no-area task block, or be blocked by, declared work', () => {
		// A declares nothing → no lease; it runs alongside B's declared area, and
		// alongside in-flight work, instead of demanding exclusivity.
		expect(
			ids(
				selectDispatchable({
					candidates: [task('A', { areas: [] }), task('B', { areas: ['y'] })],
					busyAreas: none,
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['A', 'B'])

		expect(
			ids(
				selectDispatchable({
					candidates: [task('A', { areas: [] })],
					busyAreas: new Set(['y']),
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['A'])
	})

	it('holds a task with an unmet blocker, releases it once the blocker clears', () => {
		expect(
			ids(
				selectDispatchable({
					candidates: [task('B', { blockedBy: ['A'] })],
					busyAreas: none,
					pending: new Set(['A']),
					capacity: 5,
				}),
			),
		).toEqual([])
		expect(
			ids(
				selectDispatchable({
					candidates: [task('B', { blockedBy: ['A'] })],
					busyAreas: none,
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['B'])
	})

	it('respects capacity and returns nothing at zero capacity', () => {
		expect(
			selectDispatchable({
				candidates: [task('A')],
				busyAreas: none,
				pending: none,
				capacity: 0,
			}),
		).toEqual([])
	})
})
