import { describe, expect, it } from 'vitest'
import { resolvePromptPath } from './config'

describe('resolvePromptPath', () => {
	it('maps dev to the dev-loop prompt', () => {
		expect(resolvePromptPath('/repo', 'dev')).toBe(
			'/repo/.agent/prompts/dev-loop.md',
		)
	})

	it('maps qa to the qa-loop prompt', () => {
		expect(resolvePromptPath('/repo', 'qa')).toBe(
			'/repo/.agent/prompts/qa-loop.md',
		)
	})
})
