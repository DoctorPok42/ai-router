import type { Register } from 'claude-code'

import { EFFORTS, MODELS, PROJECT_RULES_FILE, ROUTING_RULES, promptSignals, withProjectRules } from './rules'

const MODEL_ORDER = Object.keys(MODELS) as (keyof typeof MODELS)[]

const LOG_KEY = 'routing-log'
const LOG_ENTRY_PREFIX = `${LOG_KEY}:`
const LOG_MAX = 500
const ROUTER_TIMEOUT_MS = 8000
// Downgrading the model invalidates the prompt cache: wait for a second lower decision in a row.
const DOWNGRADE_AFTER = 2
// Unambiguous acknowledgements: they continue the previous task, no router call needed.
const ACKNOWLEDGEMENTS = [
  'ok', 'okay', 'go', 'go on', 'go ahead', 'next', 'yes', 'y', 'thanks', 'thank you', 'thx', 'lgtm',
  'looks good', 'sounds good', 'perfect', 'great',
  'oui', 'merci', 'vas[- ]y', "d['’]?accord", 'parfait', 'super', 'top', 'nickel', 'allez', 'continue[zr]?', 'suite',
].join('|')
const FOLLOW_UP = new RegExp(`^(?:${ACKNOWLEDGEMENTS})(?:[\\s,.!]+(?:${ACKNOWLEDGEMENTS}))*[\\s.!]*$`, 'i')

type Decision = {
  model: keyof typeof MODELS
  effort: (typeof EFFORTS)[number]
  reason: string
}

const SYSTEM = `${ROUTING_RULES}

Reply with only this JSON object, nothing else:
{"model": "haiku|sonnet|opus", "effort": "low|medium|high|xhigh|max", "reason": "one short sentence in the language of the prompt"}`

type LogEntry = Decision & { at: string; input: string; source: 'haiku' | 'follow-up' }
type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
}

// One key per entry: sessions share the store and a get-then-set on a single key would overwrite each other.
async function entryKeys(store: Store): Promise<string[]> {
  return (await store.keys()).filter(k => k.startsWith(LOG_ENTRY_PREFIX)).sort()
}

async function readLog(store: Store): Promise<LogEntry[]> {
  const legacy = await store.get(LOG_KEY)
  const entries = await Promise.all((await entryKeys(store)).map(k => store.get(k)))
  return [...(Array.isArray(legacy) ? legacy : []), ...entries].slice(-LOG_MAX) as LogEntry[]
}

async function record(store: Store, entry: LogEntry): Promise<void> {
  await store.set(`${LOG_ENTRY_PREFIX}${String(Date.now()).padStart(13, '0')}-${Math.random().toString(36).slice(2, 8)}`, entry)
  const keys = await entryKeys(store)
  await Promise.all(keys.slice(0, -LOG_MAX).map(k => store.delete(k)))
}

async function clearLog(store: Store): Promise<number> {
  const count = (await readLog(store)).length
  await Promise.all([store.delete(LOG_KEY), ...(await entryKeys(store)).map(k => store.delete(k))])
  return count
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
  const last = entries.slice(-5).map(e => `  ${e.at.slice(0, 16)} ${e.model}/${e.effort} [${e.source}]${e.input ? ` ${e.input.slice(0, 60)}` : ''}`)
  return [
    `auto-route log: ${entries.length} decisions (${skipped} without a router call)`,
    ...lines,
    'Last 5:',
    ...last,
  ].join('\n')
}

function limit<T extends string>(order: readonly T[], value: T, min: unknown, max: unknown): T {
  const floor = Math.max(order.indexOf(min as T), 0)
  const ceiling = order.indexOf(max as T) === -1 ? order.length - 1 : order.indexOf(max as T)
  return order[Math.min(Math.max(order.indexOf(value), floor), ceiling)]
}

// Keeps a decision within the floors and ceilings set in the plugin options; the ceiling wins if they conflict.
export function clamp(decision: Decision, options: Record<string, unknown>): Decision {
  return {
    ...decision,
    model: limit(MODEL_ORDER, decision.model, options.minModel, options.maxModel),
    effort: limit(EFFORTS, decision.effort, options.minEffort, options.maxEffort),
  }
}

// Keeps the current model when the router proposes a lower one, until it does so DOWNGRADE_AFTER times in a row.
export function holdModel(proposed: Decision, current: Decision | undefined, lowerStreak: number): { decision: Decision; lowerStreak: number } {
  if (!current || MODEL_ORDER.indexOf(proposed.model) >= MODEL_ORDER.indexOf(current.model) || lowerStreak + 1 >= DOWNGRADE_AFTER) {
    return { decision: proposed, lowerStreak: 0 }
  }
  const reason = `${proposed.reason} (keeping ${current.model} to preserve the cache)`
  return { decision: { ...proposed, model: current.model, reason }, lowerStreak: lowerStreak + 1 }
}

export function describeStatus(isEnabled: boolean, current: Decision | undefined, isPinned: boolean, options: Record<string, unknown>): string {
  return [
    `auto-route: ${isEnabled ? 'enabled' : 'disabled'}`,
    `decision: ${current ? `${current.model}/${current.effort}${isPinned ? ' (pinned)' : ` - ${current.reason}`}` : 'none yet'}`,
    `limits: ${options.minModel ?? MODEL_ORDER[0]}/${options.minEffort ?? EFFORTS[0]} to ${options.maxModel ?? MODEL_ORDER.at(-1)}/${options.maxEffort ?? EFFORTS.at(-1)}`,
    `prompts in the log: ${options.logPrompts === false ? 'no' : 'yes'}`,
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
    if (!Object.hasOwn(MODELS, d.model) || !EFFORTS.includes(d.effort)) return undefined
    return { model: d.model, effort: d.effort, reason: String(d.reason ?? '') }
  } catch {
    return undefined
  }
}

const storeOf = ($: { store: Store }): Store => ({
  get: k => $.store.get(k),
  set: (k, v) => $.store.set(k, v),
  delete: k => $.store.delete(k),
  keys: () => $.store.keys(),
})

export const register: Register = (on, options) => {
  let isEnabled = true
  let current: Decision | undefined
  let pinned: Decision | undefined
  let lowerStreak = 0
  const logsPrompts = () => options.logPrompts !== false
  const history: { user: string; assistant?: string; decision: Decision }[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-route',
      description: 'Automatic model and effort selection: on | off | status | pin <model> <effort> | unpin | log [clear]',
    })

    return next(e)
  })

  on('command.run', { command: 'auto-route' }, async ($, e) => {
    const [action = '', ...rest] = e.args.split(/\s+/).filter(Boolean)
    const store = storeOf($)

    switch (action) {
      case 'log':
        if (rest[0] === 'clear') return { text: `auto-route log cleared (${await clearLog(store)} decisions)` }
        return { text: summarize(await readLog(store)) }
      case 'status':
        return { text: describeStatus(isEnabled, current, !!pinned, options) }
      case 'pin': {
        const [model, effort] = rest
        if (!Object.hasOwn(MODELS, model) || !EFFORTS.includes(effort as Decision['effort'])) {
          return { text: 'usage: /auto-route pin <haiku|sonnet|opus> <low|medium|high|xhigh|max>' }
        }
        pinned = current = clamp({ model, effort, reason: 'pinned' } as Decision, options)
        isEnabled = true
        history.length = 0
        $.ui.status(`auto: ${pinned.model}/${pinned.effort} - pinned`)
        const isCapped = pinned.model !== model || pinned.effort !== effort
        return { text: `auto-route pinned to ${pinned.model}/${pinned.effort}${isCapped ? ` (${model}/${effort} requested, limited by the plugin options)` : ''}` }
      }
      case 'unpin':
        if (!pinned) return { text: 'auto-route: nothing is pinned' }
        pinned = current = undefined
        $.ui.status(undefined)
        return { text: 'auto-route unpinned, routing resumes with the next prompt' }
      case '':
      case 'on':
      case 'off':
        isEnabled = action === 'on' ? true : action === 'off' ? false : !isEnabled
        if (!isEnabled) {
          pinned = current = undefined
          history.length = 0
          $.ui.status(undefined)
        }
        return { text: `auto-route ${isEnabled ? 'enabled' : 'disabled'}` }
      default:
        return { text: 'usage: /auto-route [on|off|status|pin <model> <effort>|unpin|log [clear]]' }
    }
  })

  // A routing failure must never block the prompt.
  on('prompt.submit', async ($, e, next) => {
    if (!isEnabled || pinned || e.text.startsWith('/')) return next(e)

    const store = storeOf($)
    if (current && isFollowUp(e.text)) {
      history.push({ user: e.text, decision: current })
      await record(store, { ...current, at: new Date().toISOString(), input: logsPrompts() ? e.text : '', source: 'follow-up' }).catch(() => {})
      return next(e)
    }

    const context = history
      .slice(-3)
      .map(h => `USER: ${clip(h.user)}\nROUTED: ${h.decision.model}/${h.decision.effort}${h.assistant ? `\nASSISTANT: ${clip(h.assistant)}` : ''}`)
      .join('\n\n')
    const projectRules = await $.fs.read(PROJECT_RULES_FILE).catch(() => undefined)
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      system: withProjectRules(SYSTEM, projectRules),
      prompt: `${context ? `Recent conversation:\n${context}\n\n` : ''}Prompt signals: ${promptSignals(e.text, e.attachments?.map(a => a.type))}\n\nNew prompt to route:\n${e.text}`,
      maxTokens: 300,
      timeoutMs: ROUTER_TIMEOUT_MS,
    })
    const parsed = r.isAnswered ? parseDecision(r.text) : undefined
    const held = parsed && holdModel(parsed, current, lowerStreak)
    const decision = held && clamp(held.decision, options)
    if (held) lowerStreak = held.lowerStreak
    if (decision) {
      current = decision
      history.push({ user: e.text, decision })
      await record(store, { ...decision, at: new Date().toISOString(), input: logsPrompts() ? e.text.slice(0, 500) : '', source: 'haiku' }).catch(() => {})
    }
    $.ui.status(
      !current
        ? 'auto: router unavailable, using session model'
        : decision
          ? `auto: ${current.model}/${current.effort} - ${current.reason}`
          : `auto: ${current.model}/${current.effort} (stale) - router unavailable`,
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  // Subagents keep their own model and effort.
  on('turn.step', async function* ($, e, next) {
    if (!isEnabled || !current || e.agentId) return yield* next(e)

    const result = yield* next({ ...e, model: MODELS[current.model], effort: current.effort })
    const last = history.at(-1)
    if (last && result?.answer) last.assistant = result.answer

    return result
  })
}
