import { expect, test } from 'claude-code/testing'

import { parseDecision } from '../hooks/register'

function hooks(on: any, reply: string, seen: { model?: string; effort?: unknown }[]) {
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: { inputTokens: 1, outputTokens: 1 } } }))
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
