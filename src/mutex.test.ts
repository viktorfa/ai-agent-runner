import { describe, expect, it } from 'vitest'
import { createSerializer } from './mutex'

describe('createSerializer', () => {
	it('runs operations one at a time, in call order, even when a later one is faster', async () => {
		const serialize = createSerializer()
		const events: string[] = []
		const op = (id: string, ms: number) =>
			serialize(async () => {
				events.push(`start ${id}`)
				await new Promise((r) => setTimeout(r, ms))
				events.push(`end ${id}`)
			})
		// B is faster but queued behind A — there must be no interleaving.
		await Promise.all([op('A', 20), op('B', 1)])
		expect(events).toEqual(['start A', 'end A', 'start B', 'end B'])
	})

	it('keeps the chain going after an operation throws', async () => {
		const serialize = createSerializer()
		const events: string[] = []
		const settled = await Promise.allSettled([
			serialize(async () => {
				events.push('A')
				throw new Error('boom')
			}),
			serialize(async () => {
				events.push('B')
			}),
		])
		expect(events).toEqual(['A', 'B']) // B still ran after A rejected
		expect(settled[0].status).toBe('rejected')
		expect(settled[1].status).toBe('fulfilled')
	})
})
