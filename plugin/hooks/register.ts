import type { Register } from 'claude-code'

const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

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
      description: 'Turn automatic model and effort selection on or off (on|off)',
    })

    return next(e)
  })

  on('command.run', { command: 'auto-route' }, async ($, e) => {
    const arg = e.args.trim()
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
