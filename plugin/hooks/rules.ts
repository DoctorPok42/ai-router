// Routing rules shared by the plugin (hooks/register.ts) and the standalone CLI (src/router.ts).
export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const ROUTING_RULES = `You route a developer's prompt to the cheapest Claude model and effort level that will handle it well.
You do not answer the prompt. You only output the routing decision.

Models (cheapest to most capable):
- haiku: trivial questions, a shell command, explaining a short snippet, renaming, formatting, small text edits.
- sonnet: typical coding work: implement a function or component, fix a clear bug, write tests, edit a few files, code review of a small diff.
- opus: multi-file refactors, bugs with an unclear cause, architecture or design decisions, migrations, security review, long or ambiguous specs.

Effort:
- low: answer is obvious, little reasoning needed.
- medium: some reasoning, single focused task.
- high: careful reasoning or several steps.
- xhigh: complex agentic coding, many files or tool calls.
- max: correctness matters more than cost and the problem is very hard.

Rules:
- Short follow-ups that continue the previous task ("ok", "go", "continue", "fix it", "and the tests?") keep the previous decision unless they clearly change difficulty.
- Switching model invalidates the prompt cache, so only change model when the difficulty clearly changed.
- The prompt signals (length, files mentioned, attachments) hint at the scope of the work; they are not a reason by themselves.
- When unsure between two levels, pick the higher one.`

export const PROJECT_RULES_FILE = '.claude/auto-route.md'
const PROJECT_RULES_MAX = 4000

export function withProjectRules(system: string, projectRules: string | undefined): string {
  const rules = projectRules?.trim().slice(0, PROJECT_RULES_MAX)
  return rules ? `${system}\n\nProject rules (they take precedence over the rules above):\n${rules}` : system
}

const FILE_MENTION = /(?:^|\s)(@\S+|[\w.~-]*\/\S*\.[A-Za-z0-9]{1,6})(?=[\s,;:)]|$)/g

// Cheap scope hints for the router: size, files mentioned (@path or path/with.ext) and attachments.
export function promptSignals(text: string, attachmentTypes: readonly string[] = []): string {
  const files = new Set([...text.matchAll(FILE_MENTION)].map(m => m[1])).size
  const counts = new Map<string, number>()
  for (const type of attachmentTypes) counts.set(type, (counts.get(type) ?? 0) + 1)
  return [
    `${text.length} characters`,
    files ? `${files} files mentioned` : '',
    ...[...counts].map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''} attached`),
  ].filter(Boolean).join(', ')
}
