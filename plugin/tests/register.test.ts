import { expect, mock, test } from 'claude-code/testing'

import { clamp, holdModel, isFollowUp, parseDecision, toEntry } from '../hooks/register'
import { promptSignals } from '../hooks/rules'

function hooks(on: any, reply: string, seen: { model?: string; effort?: unknown }[], calls = { count: 0 }, prompts: string[] = []) {
  mock.store(on)
  on('model.complete', (_: unknown, e: { prompt: string }) => (calls.count++, prompts.push(e.prompt), { value: { isAnswered: true, text: reply, usage: { inputTokens: 1, outputTokens: 1 } } }))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.step', async function* ($: unknown, e: any) {
    seen.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' }
  })
}

const STEP = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 } as const

async function step($: any, extra: object = {}) {
  const s = $.turn.step({ ...STEP, ...extra })
  for await (const _ of s);
  return s.result
}

test('applies the model and effort chosen by Haiku to the main thread', async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  hooks(on, '{"model":"opus","effort":"xhigh","reason":"complex bug"}', seen)
  await $.prompt.submit({ text: 'the Keycloak session randomly expires in production', wait: false })
  await step($)
  expect(seen).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('leaves subagents and an invalid reply untouched', async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  hooks(on, 'not json', seen)
  await $.prompt.submit({ text: 'hello', wait: false })
  await step($)
  await step($, { agentId: 'a1' })
  expect(seen).toEqual([
    { model: 'claude-sonnet-5-5', effort: 'medium' },
    { model: 'claude-sonnet-5-5', effort: 'medium' },
  ])
})

test('parseDecision rejects an unknown model', () => {
  expect(parseDecision('{"model":"fable","effort":"max","reason":"x"}')).toBe(undefined)
  expect(parseDecision('ok {"model":"haiku","effort":"low","reason":"r"}')).toEqual({ model: 'haiku', effort: 'low', reason: 'r' })
})

test('parseDecision rejects names inherited from Object.prototype', () => {
  expect(parseDecision('{"model":"toString","effort":"low","reason":"x"}')).toBe(undefined)
})

test('isFollowUp only matches plain acknowledgements', () => {
  expect(isFollowUp(' OK! ')).toBe(true)
  expect(isFollowUp('go')).toBe(true)
  expect(isFollowUp('ok but rewrite the whole module')).toBe(false)
  expect(isFollowUp('fix it')).toBe(false)
})

test('skips the router for a follow-up and keeps the previous decision', async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  const calls = { count: 0 }
  hooks(on, '{"model":"opus","effort":"xhigh","reason":"complex bug"}', seen, calls)
  await $.prompt.submit({ text: 'the Keycloak session randomly expires in production', wait: false })
  await $.prompt.submit({ text: 'ok', wait: false })
  await step($)
  expect(calls.count).toBe(1)
  expect(seen).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('/auto-route log reports the recorded decisions', async ($: any, on: any) => {
  hooks(on, '{"model":"haiku","effort":"low","reason":"trivial"}', [])
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  await $.prompt.submit({ text: 'thanks', wait: false })
  const r = await $.command.run({ command: 'auto-route', args: 'log' })
  expect(r.text).toContain('2 decisions (1 without a router call)')
  expect(r.text).toContain('haiku/low: 2')
})

test('clamp caps model and effort and leaves lower decisions alone', () => {
  const d = { model: 'opus', effort: 'max', reason: 'r' } as const
  expect(clamp(d, { maxModel: 'sonnet', maxEffort: 'high' })).toEqual({ model: 'sonnet', effort: 'high', reason: 'r' })
  expect(clamp({ model: 'haiku', effort: 'low', reason: 'r' }, { maxModel: 'sonnet', maxEffort: 'high' })).toEqual({ model: 'haiku', effort: 'low', reason: 'r' })
  expect(clamp(d, { maxModel: 'opus', maxEffort: 'max' })).toEqual(d)
  expect(clamp(d, {})).toEqual(d)
})

test('clamp raises a decision to the floors and lets the ceiling win on conflict', () => {
  const low = { model: 'haiku', effort: 'low', reason: 'r' } as const
  expect(clamp(low, { minModel: 'sonnet', minEffort: 'medium' })).toEqual({ model: 'sonnet', effort: 'medium', reason: 'r' })
  expect(clamp(low, { minModel: 'opus', maxModel: 'sonnet' }).model).toBe('sonnet')
})

test('applies the ceilings from the plugin options', { options: { maxModel: 'sonnet', maxEffort: 'high' } }, async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  hooks(on, '{"model":"opus","effort":"xhigh","reason":"complex bug"}', seen)
  await $.prompt.submit({ text: 'the Keycloak session randomly expires in production', wait: false })
  await step($)
  expect(seen).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
})

test('/auto-route off clears the history sent to the router', async ($: any, on: any) => {
  const prompts: string[] = []
  hooks(on, '{"model":"haiku","effort":"low","reason":"trivial"}', [], undefined, prompts)
  await $.prompt.submit({ text: 'first question', wait: false })
  await $.command.run({ command: 'auto-route', args: 'off' })
  await $.command.run({ command: 'auto-route', args: 'on' })
  await $.prompt.submit({ text: 'second question', wait: false })
  expect(prompts.at(-1)).not.toContain('first question')
})

test('a follow-up is kept in the history sent to the router', async ($: any, on: any) => {
  const prompts: string[] = []
  hooks(on, '{"model":"haiku","effort":"low","reason":"trivial"}', [], undefined, prompts)
  await $.prompt.submit({ text: 'first question', wait: false })
  await $.prompt.submit({ text: 'ok', wait: false })
  await $.prompt.submit({ text: 'second question', wait: false })
  expect(prompts.at(-1)).toContain('USER: ok')
})

const COMPLETE = (text: string) => ({ value: { isAnswered: true, text, usage: { inputTokens: 1, outputTokens: 1 } } })

test('flags the status as stale when the router fails after a first decision', async ($: any, on: any) => {
  const statuses: string[] = []
  const replies = ['{"model":"opus","effort":"high","reason":"hard bug"}', 'not json']
  mock.store(on)
  on('model.complete', () => COMPLETE(replies.shift()!))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', (_: unknown, e: unknown) => (statuses.push(JSON.stringify(e)), { value: undefined }))
  await $.prompt.submit({ text: 'the session randomly expires', wait: false })
  await $.prompt.submit({ text: 'now explain the cause in detail', wait: false })
  expect(statuses[0]).not.toContain('stale')
  expect(statuses[1]).toContain('opus/high (stale)')
})

test('sends the previous answer to the router as context', async ($: any, on: any) => {
  const prompts: string[] = []
  mock.store(on)
  on('model.complete', (_: unknown, e: { prompt: string }) => (prompts.push(e.prompt), COMPLETE('{"model":"sonnet","effort":"medium","reason":"r"}')))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.step', async function* ($: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'the bug is in the token refresh', toolUses: [], stopReason: 'end_turn' }
  })
  await $.prompt.submit({ text: 'why does the login fail', wait: false })
  await step($)
  await $.prompt.submit({ text: 'and the logout?', wait: false })
  expect(prompts.at(-1)).toContain('ASSISTANT: the bug is in the token refresh')
})

test('concurrent follow-ups all reach the log', async ($: any, on: any) => {
  hooks(on, '{"model":"haiku","effort":"low","reason":"trivial"}', [])
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  await Promise.all(Array.from({ length: 20 }, () => $.prompt.submit({ text: 'ok', wait: false })))
  const r = await $.command.run({ command: 'auto-route', args: 'log' })
  expect(r.text).toContain('21 decisions (20 without a router call)')
})

test('keeps only the last 500 decisions', async ($: any, on: any) => {
  hooks(on, '{"model":"haiku","effort":"low","reason":"trivial"}', [])
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  for (let i = 0; i < 504; i++) await $.prompt.submit({ text: 'ok', wait: false })
  const r = await $.command.run({ command: 'auto-route', args: 'log' })
  expect(r.text).toContain('500 decisions')
})

test('still reads the log stored under the former single key', async ($: any, on: any) => {
  mock.store(on, { 'routing-log': [{ model: 'opus', effort: 'max', reason: 'r', at: '2026-10-01T10:00:00Z', input: 'old', source: 'haiku' }] })
  on('model.complete', () => COMPLETE('{"model":"haiku","effort":"low","reason":"trivial"}'))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  const r = await $.command.run({ command: 'auto-route', args: 'log' })
  expect(r.text).toContain('2 decisions')
  expect(r.text).toContain('opus/max: 1')
})

const ROUTED = '{"model":"haiku","effort":"low","reason":"trivial"}'
const run = ($: any, args: string) => $.command.run({ command: 'auto-route', args })

test('/auto-route pin applies the pair without calling the router', async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  const calls = { count: 0 }
  hooks(on, ROUTED, seen, calls)
  const r = await run($, 'pin opus high')
  expect(r.text).toBe('auto-route pinned to opus/high')
  await $.prompt.submit({ text: 'rename this variable', wait: false })
  await step($)
  expect(calls.count).toBe(0)
  expect(seen).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('/auto-route pin respects the plugin ceilings and says so', { options: { maxModel: 'sonnet' } }, async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  const r = await run($, 'pin opus high')
  expect(r.text).toContain('pinned to sonnet/high')
  expect(r.text).toContain('opus/high requested')
})

test('/auto-route pin rejects an unknown pair', async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  expect((await run($, 'pin fable max')).text).toContain('usage: /auto-route pin')
  expect((await run($, 'pin opus')).text).toContain('usage: /auto-route pin')
})

test('/auto-route unpin resumes routing', async ($: any, on: any) => {
  const calls = { count: 0 }
  hooks(on, ROUTED, [], calls)
  expect((await run($, 'unpin')).text).toBe('auto-route: nothing is pinned')
  await run($, 'pin opus high')
  await run($, 'unpin')
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  expect(calls.count).toBe(1)
})

test('/auto-route off drops the pin', async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  await run($, 'pin opus high')
  await run($, 'off')
  expect((await run($, 'status')).text).toContain('decision: none yet')
})

test('/auto-route status reports the state, the pin and the limits', { options: { minModel: 'sonnet', logPrompts: false } }, async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  expect((await run($, 'status')).text).toBe(
    'auto-route: enabled\ndecision: none yet\nlimits: sonnet/low to opus/max\nprompts in the log: no',
  )
  await run($, 'pin sonnet medium')
  expect((await run($, 'status')).text).toContain('decision: sonnet/medium (pinned)')
})

test('/auto-route log clear empties the log', async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  await $.prompt.submit({ text: 'what does ls -la do', wait: false })
  await $.prompt.submit({ text: 'ok', wait: false })
  expect((await run($, 'log clear')).text).toBe('auto-route log cleared (2 decisions)')
  expect((await run($, 'log')).text).toContain('no decision recorded yet')
})

test('logPrompts off keeps the decisions but not the prompt text', { options: { logPrompts: false } }, async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  await $.prompt.submit({ text: 'my secret prompt', wait: false })
  const r = await run($, 'log')
  expect(r.text).toContain('1 decisions')
  expect(r.text).not.toContain('secret')
})

test('an unknown /auto-route argument shows the usage and changes nothing', async ($: any, on: any) => {
  hooks(on, ROUTED, [])
  expect((await run($, 'bogus')).text).toContain('usage: /auto-route')
  expect((await run($, 'status')).text).toContain('auto-route: enabled')
})

test('isFollowUp accepts French and English acknowledgements, alone or combined', () => {
  for (const text of ['vas-y', "d'accord", 'ok merci', 'LGTM', 'go on', 'Parfait !', 'ok, go']) expect(isFollowUp(text)).toBe(true)
  for (const text of ['next steps for the migration?', 'ok and the tests?', 'merci de corriger le bug', 'no']) expect(isFollowUp(text)).toBe(false)
})

const D = (model: 'haiku' | 'sonnet' | 'opus', effort: 'low' | 'high' = 'low') => ({ model, effort, reason: 'r' }) as const

test('holdModel switches up at once and down only on the second lower decision in a row', () => {
  expect(holdModel(D('opus'), D('sonnet'), 0)).toEqual({ decision: D('opus'), lowerStreak: 0 })
  expect(holdModel(D('opus'), undefined, 0)).toEqual({ decision: D('opus'), lowerStreak: 0 })
  const first = holdModel(D('haiku', 'high'), D('opus'), 0)
  expect(first.decision).toMatchObject({ model: 'opus', effort: 'high' })
  expect(first.decision.reason).toContain('keeping opus')
  expect(first.lowerStreak).toBe(1)
  expect(holdModel(D('haiku'), D('opus'), 1)).toEqual({ decision: D('haiku'), lowerStreak: 0 })
})

test('promptSignals reports size, files mentioned and attachments', () => {
  expect(promptSignals('hello')).toBe('5 characters')
  expect(promptSignals('see @src/a.ts and plugin/hooks/b.ts, then @src/a.ts', ['image', 'image', 'document'])).toBe(
    '51 characters, 2 files mentioned, 2 images attached, 1 document attached',
  )
  expect(promptSignals('version 1.2 e.g. this')).toBe('21 characters')
})

test('keeps the model after a single lower decision, then lets it drop', async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  const replies = [
    '{"model":"opus","effort":"high","reason":"hard"}',
    '{"model":"haiku","effort":"low","reason":"trivial"}',
    '{"model":"haiku","effort":"low","reason":"trivial"}',
  ]
  mock.store(on)
  on('model.complete', () => COMPLETE(replies.shift()!))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.step', async function* ($: unknown, e: any) {
    seen.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' }
  })
  for (const text of ['a hard problem', 'rename x', 'rename y']) {
    await $.prompt.submit({ text, wait: false })
    await step($)
  }
  expect(seen).toEqual([
    { model: 'claude-opus-5-5', effort: 'high' },
    { model: 'claude-opus-5-5', effort: 'low' },
    { model: 'claude-haiku-5-5', effort: 'low' },
  ])
})

test('sends the prompt signals and the project rules to the router', async ($: any, on: any) => {
  const seen: { system: string; prompt: string }[] = []
  mock.store(on)
  on('fs.read', () => ({ value: '  Always use opus for anything under billing/.  ' }))
  on('model.complete', (_: unknown, e: { system: string; prompt: string }) => (seen.push(e), COMPLETE(ROUTED)))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  await $.prompt.submit({ text: 'look at @billing/invoice.ts', attachments: [{ type: 'image' }], wait: false })
  expect(seen[0].prompt).toContain('Prompt signals: 27 characters, 1 files mentioned, 1 image attached')
  expect(seen[0].system).toContain('Project rules (they take precedence over the rules above):\nAlways use opus for anything under billing/.')
})

test('a missing project rules file leaves the system prompt unchanged', async ($: any, on: any) => {
  const seen: { system: string }[] = []
  mock.store(on)
  on('fs.read', () => { throw new Error('ENOENT') })
  on('model.complete', (_: unknown, e: { system: string }) => (seen.push(e), COMPLETE(ROUTED)))
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  await $.prompt.submit({ text: 'hello', wait: false })
  expect(seen[0].system).not.toContain('Project rules')
})

test('toEntry keeps the prompt and the reason only when prompt logging is on', () => {
  const decision = { model: 'opus', effort: 'high', reason: 'Keycloak session bug in billing' } as const
  expect(toEntry(decision, 'the Keycloak session expires', 'haiku', true)).toMatchObject({
    ...decision,
    input: 'the Keycloak session expires',
    source: 'haiku',
  })
  const redacted = toEntry(decision, 'the Keycloak session expires', 'haiku', false)
  expect(redacted).toMatchObject({ model: 'opus', effort: 'high', reason: '', input: '', source: 'haiku' })
  expect(JSON.stringify(redacted)).not.toContain('Keycloak')
})

test('toEntry truncates long prompts to 500 characters', () => {
  expect(toEntry({ model: 'haiku', effort: 'low', reason: 'r' }, 'x'.repeat(900), 'haiku', true).input).toHaveLength(500)
})

test('only the last 3 exchanges are sent to the router', async ($: any, on: any) => {
  const prompts: string[] = []
  hooks(on, ROUTED, [], undefined, prompts)
  for (const n of [1, 2, 3, 4, 5, 6]) await $.prompt.submit({ text: `question number ${n}`, wait: false })
  const context = prompts.at(-1)!
  expect(context).not.toContain('question number 2')
  for (const n of [3, 4, 5]) expect(context).toContain(`question number ${n}`)
})
