import { describe, expect, it } from 'vitest'
import { runLogPath } from './log-path'

describe('runLogPath', () => {
	it('builds a sortable, filesystem-safe transcript path under loop/', () => {
		expect(
			runLogPath({
				workspace: '/repo',
				assistant: 'codex',
				timestamp: '2026-06-24T00:17:39.123Z',
			}),
		).toBe('/repo/loop/codex-2026-06-24T00-17-39.log')
	})

	it('is relative to the workspace', () => {
		expect(
			runLogPath({
				workspace: '.',
				assistant: 'claude',
				timestamp: '2026-06-24T09:05:00.000Z',
			}),
		).toBe('loop/claude-2026-06-24T09-05-00.log')
	})
})
