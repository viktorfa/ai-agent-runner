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
	it('dispatches risk:low tasks in disjoint areas up to capacity', () => {
		const out = selectDispatchable({
			candidates: [
				task('A', { areas: ['x'] }),
				task('B', { areas: ['y'] }),
				task('C', { areas: ['z'] }),
			],
			busyAreas: none,
			pending: none,
			capacity: 2,
		})
		expect(ids(out)).toEqual(['A', 'B'])
	})

	it('excludes needs-human and unspecified-risk tasks', () => {
		const out = selectDispatchable({
			candidates: [
				task('A', { risk: 'needs-human', areas: ['x'] }),
				task('B', { risk: undefined, areas: ['y'] }),
				task('C', { areas: ['z'] }),
			],
			busyAreas: none,
			pending: none,
			capacity: 5,
		})
		expect(ids(out)).toEqual(['C'])
	})

	it('serializes tasks whose areas overlap each other or in-flight work', () => {
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
		).toEqual(['A']) // B overlaps A's lease

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

	it('holds a task with an unmet blocker, releases it once the blocker clears', () => {
		expect(
			ids(
				selectDispatchable({
					candidates: [task('B', { areas: ['y'], blockedBy: ['A'] })],
					busyAreas: none,
					pending: new Set(['A']),
					capacity: 5,
				}),
			),
		).toEqual([])
		expect(
			ids(
				selectDispatchable({
					candidates: [task('B', { areas: ['y'], blockedBy: ['A'] })],
					busyAreas: none,
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['B'])
	})

	it('treats an unknown footprint (no areas) as needing exclusivity', () => {
		expect(
			ids(
				selectDispatchable({
					candidates: [task('A', { areas: [] }), task('B', { areas: ['y'] })],
					busyAreas: none,
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual(['A']) // A holds the wildcard lease; B can't join this round

		expect(
			ids(
				selectDispatchable({
					candidates: [task('A', { areas: [] })],
					busyAreas: new Set(['y']),
					pending: none,
					capacity: 5,
				}),
			),
		).toEqual([]) // can't start an unknown-footprint task while anything is in flight
	})

	it('respects capacity and returns nothing at zero capacity', () => {
		expect(
			selectDispatchable({
				candidates: [task('A', { areas: ['x'] })],
				busyAreas: none,
				pending: none,
				capacity: 0,
			}),
		).toEqual([])
	})
})
