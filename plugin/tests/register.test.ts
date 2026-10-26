import { expect, mock, test } from 'claude-code/testing'

import { clamp, isFollowUp, parseDecision } from '../hooks/register'

function hooks(on: any, reply: string, seen: { model?: string; effort?: unknown }[], calls = { count: 0 }) {
  mock.store(on)
  on('model.complete', () => (calls.count++, { value: { isAnswered: true, text: reply, usage: { inputTokens: 1, outputTokens: 1 } } }))
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
  expect(clamp(d, 'sonnet', 'high')).toEqual({ model: 'sonnet', effort: 'high', reason: 'r' })
  expect(clamp({ model: 'haiku', effort: 'low', reason: 'r' }, 'sonnet', 'high')).toEqual({ model: 'haiku', effort: 'low', reason: 'r' })
  expect(clamp(d, 'opus', 'max')).toEqual(d)
})

test('applies the ceilings from the plugin options', { options: { maxModel: 'sonnet', maxEffort: 'high' } }, async ($: any, on: any) => {
  const seen: { model?: string; effort?: unknown }[] = []
  hooks(on, '{"model":"opus","effort":"xhigh","reason":"complex bug"}', seen)
  await $.prompt.submit({ text: 'the Keycloak session randomly expires in production', wait: false })
  await step($)
  expect(seen).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
})
