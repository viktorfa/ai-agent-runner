/**
 * Parse a Backlog task's metadata from its markdown (YAML-ish frontmatter + the
 * `## Acceptance Criteria` section). The parallel-agents design needs the harness —
 * not just the agent — to know each task's risk tier, the areas it touches, what it's
 * blocked by, and the docs it points at, so it can route, lease, and assemble a brief
 * (see docs/PARALLEL_AGENTS.md). Backlog has no `--json`, so we read the file Backlog
 * already writes.
 *
 * Pure: takes the markdown string, returns a typed value. Reading the file is `io.ts`.
 * We parse only the field shapes Backlog actually emits (flat scalars + string lists,
 * block or inline) rather than pulling in a YAML dependency — the core stays dep-free.
 */

/** Risk tier, from a `risk:<tier>` label. Routing policy/defaults live in the caller. */
export type Risk = 'low' | 'needs-human'

export interface AcceptanceCriterion {
	text: string
	done: boolean
}

export interface TaskMeta {
	id: string
	title?: string
	status?: string
	priority?: string
	labels: string[]
	/** Task ids this one is blocked by (Backlog `dependencies`). */
	blockedBy: string[]
	/** Repo-relative docs the task points at (Backlog `documentation`) — brief context. */
	documentation: string[]
	/** Risk tier from a `risk:<tier>` label, if present. */
	risk?: Risk
	/** Areas from `area:<name>` labels — the lease set for conflict-aware scheduling. */
	areas: string[]
	acceptanceCriteria: AcceptanceCriterion[]
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/

export function parseTask(markdown: string): TaskMeta {
	const fm = parseFrontmatter(markdown)
	const labels = asList(fm.labels)
	return {
		id: asScalar(fm.id) ?? '',
		title: asScalar(fm.title),
		status: asScalar(fm.status),
		priority: asScalar(fm.priority),
		labels,
		blockedBy: asList(fm.dependencies),
		documentation: asList(fm.documentation),
		risk: riskFromLabels(labels),
		areas: labelValues(labels, 'area:'),
		acceptanceCriteria: parseAcceptanceCriteria(markdown),
	}
}

type FrontmatterValue = string | string[]

/**
 * Parse the leading `--- ... ---` block into a flat key→value map. Handles the shapes
 * Backlog emits: scalars (`status: Done`), inline lists (`dependencies: []`,
 * `[a, b]`), block lists (`labels:` then `  - x`), and folded scalars (`title: >-`).
 */
function parseFrontmatter(markdown: string): Record<string, FrontmatterValue> {
	const block = FRONTMATTER.exec(markdown)
	if (!block) return {}
	const lines = block[1].split('\n')
	const out: Record<string, FrontmatterValue> = {}
	for (let i = 0; i < lines.length; i++) {
		const head = /^([A-Za-z0-9_]+):(.*)$/.exec(lines[i])
		if (!head) continue // indented continuation lines are consumed below, not here
		const [, key, rest] = head
		const inline = rest.trim()
		if (inline.startsWith('[') && inline.endsWith(']')) {
			const inner = inline.slice(1, -1).trim()
			out[key] =
				inner === '' ? [] : inner.split(',').map((s) => stripQuotes(s.trim()))
		} else if (inline === '' || isBlockScalar(inline)) {
			// Peek the indented continuation: `- ` items make a list; otherwise it's a
			// folded scalar (e.g. a multi-line title).
			const items: string[] = []
			const folded: string[] = []
			let j = i + 1
			for (; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
				const trimmed = lines[j].trim()
				if (trimmed.startsWith('- '))
					items.push(stripQuotes(trimmed.slice(2).trim()))
				else folded.push(trimmed)
			}
			i = j - 1
			if (items.length > 0) out[key] = items
			else if (isBlockScalar(inline)) out[key] = folded.join(' ')
			// else: a bare empty key — leave unset
		} else {
			out[key] = stripQuotes(inline)
		}
	}
	return out
}

const isBlockScalar = (s: string): boolean =>
	s === '>' || s === '>-' || s === '|' || s === '|-'

const stripQuotes = (s: string): string => s.replace(/^['"]|['"]$/g, '')

const asScalar = (v: FrontmatterValue | undefined): string | undefined =>
	typeof v === 'string' && v !== '' ? v : undefined

const asList = (v: FrontmatterValue | undefined): string[] =>
	Array.isArray(v) ? v : typeof v === 'string' && v !== '' ? [v] : []

function riskFromLabels(labels: string[]): Risk | undefined {
	const [tier] = labelValues(labels, 'risk:')
	return tier === 'low' || tier === 'needs-human' ? tier : undefined
}

/** Values of `prefix`-prefixed labels (e.g. `area:rendering` → `rendering`). */
const labelValues = (labels: string[], prefix: string): string[] =>
	labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length))

function parseAcceptanceCriteria(markdown: string): AcceptanceCriterion[] {
	const lines = markdown.split('\n')
	const start = lines.findIndex((l) => /^##\s+Acceptance Criteria\b/i.test(l))
	if (start < 0) return []
	const out: AcceptanceCriterion[] = []
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) break // next section ends the AC block
		const m = /^- \[([ xX])\]\s*(?:#\d+\s*)?(.*)$/.exec(lines[i].trim())
		if (m) out.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim() })
	}
	return out
}
