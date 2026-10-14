import type { Register } from 'claude-code'

const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const LOG_KEY = 'routing-log'
const LOG_MAX = 500
// Unambiguous acknowledgements: they continue the previous task, no router call needed.
const FOLLOW_UP = /^(ok|okay|go|continue|yes|y|oui|thanks|thank you|thx|merci)[\s.!]*$/i

type Decision = {
  model: keyof typeof MODELS
  effort: (typeof EFFORTS)[number]
  reason: string
}

const SYSTEM = `You route a developer's prompt to the cheapest Claude model and effort level that will handle it well.
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
- When unsure between two levels, pick the higher one.

Reply with only this JSON object, nothing else:
{"model": "haiku|sonnet|opus", "effort": "low|medium|high|xhigh|max", "reason": "one short sentence in the language of the prompt"}`

type LogEntry = Decision & { at: string; input: string; source: 'haiku' | 'follow-up' }
type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

async function readLog(store: Store): Promise<LogEntry[]> {
  const value = await store.get(LOG_KEY)
  return Array.isArray(value) ? (value as LogEntry[]) : []
}

async function record(store: Store, entry: LogEntry): Promise<void> {
  await store.set(LOG_KEY, [...(await readLog(store)), entry].slice(-LOG_MAX))
}

export function isFollowUp(text: string): boolean {
  return FOLLOW_UP.test(text.trim())
}

export function summarize(entries: readonly LogEntry[]): string {
  if (!entries.length) return 'auto-route log: no decision recorded yet'
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(`${e.model}/${e.effort}`, (counts.get(`${e.model}/${e.effort}`) ?? 0) + 1)
  const skipped = entries.filter(e => e.source === 'follow-up').length
  const lines = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`)
  const last = entries.slice(-5).map(e => `  ${e.at.slice(0, 16)} ${e.model}/${e.effort} [${e.source}] ${e.input.slice(0, 60)}`)
  return [
    `auto-route log: ${entries.length} decisions (${skipped} without a router call)`,
    ...lines,
    'Last 5:',
    ...last,
  ].join('\n')
}

function clip(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}...` : text
}

export function parseDecision(text: string): Decision | undefined {
  const json = text.match(/\{[\s\S]*\}/)
  if (!json) return undefined
  try {
    const d = JSON.parse(json[0])
    if (!(d.model in MODELS) || !EFFORTS.includes(d.effort)) return undefined
    return { model: d.model, effort: d.effort, reason: String(d.reason ?? '') }
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  let isEnabled = true
  let current: Decision | undefined
  const history: { user: string; decision: Decision }[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-route',
      description: 'Turn automatic model and effort selection on or off (on|off), or show the decision log (log)',
    })

    return next(e)
  })

  on('command.run', { command: 'auto-route' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'log') return { text: summarize(await readLog({ get: k => $.store.get(k), set: (k, v) => $.store.set(k, v) })) }
    isEnabled = arg === 'on' ? true : arg === 'off' ? false : !isEnabled
    if (!isEnabled) {
      current = undefined
      $.ui.status(undefined)
    }

    return { text: `auto-route ${isEnabled ? 'enabled' : 'disabled'}` }
  })

  // A routing failure must never block the prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!isEnabled || e.text.startsWith('/')) return next(e)

    const store: Store = { get: k => $.store.get(k), set: (k, v) => $.store.set(k, v) }
    if (current && isFollowUp(e.text)) {
      await record(store, { ...current, at: new Date().toISOString(), input: e.text, source: 'follow-up' }).catch(() => {})
      return next(e)
    }

    const context = history
      .slice(-3)
      .map(h => `USER: ${clip(h.user)}\nROUTED: ${h.decision.model}/${h.decision.effort}`)
      .join('\n\n')
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      system: SYSTEM,
      prompt: `${context ? `Recent conversation:\n${context}\n\n` : ''}New prompt to route:\n${e.text}`,
      maxTokens: 300,
      timeoutMs: 20000,
    })
    const decision = r.isAnswered ? parseDecision(r.text) : undefined
    if (decision) {
      current = decision
      history.push({ user: e.text, decision })
      await record(store, { ...decision, at: new Date().toISOString(), input: e.text.slice(0, 500), source: 'haiku' }).catch(() => {})
    }
    $.ui.status(
      current
        ? `auto: ${current.model}/${current.effort} - ${current.reason}`
        : 'auto: router unavailable, using session model',
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  // Subagents keep their own model and effort.
  on('turn.step', async function* ($, e, next) {
    if (!isEnabled || !current || e.agentId) return yield* next(e)

    return yield* next({ ...e, model: MODELS[current.model], effort: current.effort })
  })
}
