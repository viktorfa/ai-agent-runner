import { describe, expect, it } from 'vitest'
import { parseReadyTaskIds } from './board'

const BOARD = `To Do:
  [HIGH] TASK-65 - Anchor witness lines to the outer face
  TASK-66 - Architecture intent for the hot cluster

In Progress:
  TASK-70 - Something being worked

Blocked:
  TASK-99 - Parked earlier

Done:
  TASK-1 - Smoke
`

describe('parseReadyTaskIds', () => {
	it('returns the To Do task ids in listing order', () => {
		expect(parseReadyTaskIds(BOARD)).toEqual(['TASK-65', 'TASK-66'])
	})

	it('ignores tasks in other sections', () => {
		const ids = parseReadyTaskIds(BOARD)
		expect(ids).not.toContain('TASK-70')
		expect(ids).not.toContain('TASK-99')
		expect(ids).not.toContain('TASK-1')
	})

	it('returns [] when To Do is empty', () => {
		expect(parseReadyTaskIds('To Do:\n\nDone:\n  TASK-1 - x\n')).toEqual([])
	})

	it('returns [] when there is no board / no To Do section', () => {
		expect(parseReadyTaskIds('')).toEqual([])
		expect(parseReadyTaskIds('Done:\n  TASK-1 - x\n')).toEqual([])
	})

	it('normalises task id case', () => {
		expect(parseReadyTaskIds('To Do:\n  task-12 - lower\n')).toEqual([
			'TASK-12',
		])
	})
})
