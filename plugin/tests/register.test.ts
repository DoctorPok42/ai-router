import { expect, mock, test } from 'claude-code/testing'

import { clamp, isFollowUp, parseDecision } from '../hooks/register'

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
