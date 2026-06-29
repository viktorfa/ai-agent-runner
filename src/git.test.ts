import { describe, expect, it } from 'vitest'
import {
	baseBranchPushArgs,
	fetchArgs,
	headShaArgs,
	mergeAbortArgs,
	mergeBaseArgs,
	mergeTaskBranchArgs,
	promoteWorkBranchArgs,
	remoteAheadBehindArgs,
	remoteBranchExistsArgs,
	remoteDiffStatArgs,
	resetHardArgs,
	resetWorkBranchArgs,
	showFileAtRefArgs,
	taskBranch,
	unmergedCountArgs,
	workBranchPushArgs,
	worktreeAddArgs,
	worktreePruneArgs,
	worktreeRemoveArgs,
} from './git'

describe('workBranchPushArgs', () => {
	it('force-with-leases the current HEAD to the named origin branch', () => {
		expect(workBranchPushArgs('auto/work')).toEqual([
			'push',
			'--force-with-lease',
			'origin',
			'HEAD:auto/work',
		])
	})

	it('pushes a base branch without force', () => {
		expect(baseBranchPushArgs('master')).toEqual([
			'push',
			'origin',
			'HEAD:master',
		])
	})
})

describe('prep args', () => {
	it('fetchArgs fetches origin', () => {
		expect(fetchArgs()).toEqual(['fetch', 'origin'])
	})

	it('showFileAtRefArgs reads a file blob from a ref', () => {
		expect(showFileAtRefArgs('origin/master', '.agent/config.json')).toEqual([
			'show',
			'origin/master:.agent/config.json',
		])
	})

	it('resetWorkBranchArgs force-resets the work branch to origin/base (clean scratch)', () => {
		expect(resetWorkBranchArgs('auto/work', 'master')).toEqual([
			'checkout',
			'-f',
			'-B',
			'auto/work',
			'origin/master',
		])
	})

	it('unmergedCountArgs counts work-branch commits not in base', () => {
		expect(unmergedCountArgs('master', 'auto/work')).toEqual([
			'rev-list',
			'--count',
			'origin/master..origin/auto/work',
		])
	})
})

describe('accumulate args', () => {
	it('remoteBranchExistsArgs verifies the origin ref quietly', () => {
		expect(remoteBranchExistsArgs('auto/work')).toEqual([
			'rev-parse',
			'--verify',
			'--quiet',
			'refs/remotes/origin/auto/work',
		])
	})

	it('mergeBaseArgs merges origin/base without opening an editor', () => {
		expect(mergeBaseArgs('master')).toEqual([
			'merge',
			'--no-edit',
			'origin/master',
		])
	})

	it('mergeAbortArgs aborts an in-progress merge', () => {
		expect(mergeAbortArgs()).toEqual(['merge', '--abort'])
	})
})

describe('worktree args', () => {
	it('taskBranch namespaces a lowercase per-task branch', () => {
		expect(taskBranch('TASK-136')).toBe('auto/task-136')
	})

	it('worktreeAddArgs adds a worktree on a reset branch cut from a base ref', () => {
		expect(
			worktreeAddArgs('/w/.worktrees/TASK-1', 'auto/task-1', 'auto/work'),
		).toEqual([
			'worktree',
			'add',
			'-B',
			'auto/task-1',
			'/w/.worktrees/TASK-1',
			'auto/work',
		])
	})

	it('worktreeRemoveArgs force-removes a worktree', () => {
		expect(worktreeRemoveArgs('/w/.worktrees/TASK-1')).toEqual([
			'worktree',
			'remove',
			'--force',
			'/w/.worktrees/TASK-1',
		])
	})

	it('worktreePruneArgs prunes stale worktree bookkeeping', () => {
		expect(worktreePruneArgs()).toEqual(['worktree', 'prune'])
	})
})

describe('integrator args', () => {
	it('headShaArgs reads the current HEAD sha', () => {
		expect(headShaArgs()).toEqual(['rev-parse', 'HEAD'])
	})

	it('mergeTaskBranchArgs merges a task branch as a no-ff merge commit', () => {
		expect(mergeTaskBranchArgs('auto/task-1')).toEqual([
			'merge',
			'--no-edit',
			'--no-ff',
			'auto/task-1',
		])
	})

	it('resetHardArgs hard-resets to a sha', () => {
		expect(resetHardArgs('abc123')).toEqual(['reset', '--hard', 'abc123'])
	})

	it('promoteWorkBranchArgs fast-forwards base to staging', () => {
		expect(promoteWorkBranchArgs('auto/work')).toEqual([
			'merge',
			'--ff-only',
			'origin/auto/work',
		])
	})

	it('remoteAheadBehindArgs compares remote branches', () => {
		expect(remoteAheadBehindArgs('master', 'auto/work')).toEqual([
			'rev-list',
			'--left-right',
			'--count',
			'origin/master...origin/auto/work',
		])
	})

	it('remoteDiffStatArgs summarizes remote staging changes', () => {
		expect(remoteDiffStatArgs('master', 'auto/work')).toEqual([
			'diff',
			'--stat',
			'origin/master..origin/auto/work',
		])
	})
})
