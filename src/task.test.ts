import { describe, expect, it } from 'vitest'
import { parseTask } from './task'

// A realistic Backlog task file (the shapes Backlog actually writes).
const TASK_136 = `---
id: TASK-136
title: >-
  Facade entrance stair: drop the railing line and fix the wrong-angle stair
  profile
status: Done
assignee: []
created_date: '2026-06-28 21:40'
labels:
  - rendering
  - bug
  - risk:low
  - area:rendering
dependencies: []
documentation:
  - docs/facades/FACADE_GROUND_TRUTH.md
priority: medium
ordinal: 86200
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Some prose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Railing is no longer drawn
- [ ] #2 West facade reads at the correct angle
<!-- AC:END -->

## Implementation Notes
- [ ] not a criterion (different section)
`

describe('parseTask', () => {
	it('parses frontmatter scalars, lists, and the folded title', () => {
		const t = parseTask(TASK_136)
		expect(t.id).toBe('TASK-136')
		expect(t.status).toBe('Done')
		expect(t.priority).toBe('medium')
		expect(t.title).toBe(
			'Facade entrance stair: drop the railing line and fix the wrong-angle stair profile',
		)
		expect(t.labels).toEqual(['rendering', 'bug', 'risk:low', 'area:rendering'])
		expect(t.documentation).toEqual(['docs/facades/FACADE_GROUND_TRUTH.md'])
		expect(t.blockedBy).toEqual([]) // inline empty list
	})

	it('derives risk tier and areas from labels', () => {
		expect(parseTask(TASK_136).risk).toBe('low')
		expect(parseTask(TASK_136).areas).toEqual(['rendering'])
		expect(
			parseTask('---\nid: T1\nlabels:\n  - risk:needs-human\n---').risk,
		).toBe('needs-human')
		expect(parseTask('---\nid: T1\nlabels:\n  - bug\n---').risk).toBeUndefined()
		expect(
			parseTask('---\nid: T1\nlabels:\n  - risk:medium\n---').risk,
		).toBeUndefined()
	})

	it('parses acceptance criteria with done state, stripping the #N prefix', () => {
		const ac = parseTask(TASK_136).acceptanceCriteria
		expect(ac).toEqual([
			{ done: true, text: 'Railing is no longer drawn' },
			{ done: false, text: 'West facade reads at the correct angle' },
		])
		// the checkbox under a later section must not leak into AC
		expect(ac).toHaveLength(2)
	})

	it('reads dependencies as the blocked-by set (block and inline forms)', () => {
		const block = parseTask(
			'---\nid: T2\ndependencies:\n  - TASK-1\n  - TASK-2\n---',
		)
		expect(block.blockedBy).toEqual(['TASK-1', 'TASK-2'])
		const inline = parseTask('---\nid: T3\ndependencies: [TASK-1, TASK-2]\n---')
		expect(inline.blockedBy).toEqual(['TASK-1', 'TASK-2'])
	})

	it('is safe on markdown without frontmatter or an AC section', () => {
		const t = parseTask('# just a heading\nno frontmatter here')
		expect(t.id).toBe('')
		expect(t.labels).toEqual([])
		expect(t.blockedBy).toEqual([])
		expect(t.documentation).toEqual([])
		expect(t.areas).toEqual([])
		expect(t.acceptanceCriteria).toEqual([])
		expect(t.risk).toBeUndefined()
	})
})
