import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { route, type Decision, type Exchange } from "./router.ts";

const DEFAULT: Decision = { model: "sonnet", effort: "medium", reason: "default" };
const LOG_DIR = join(import.meta.dirname, "..", "logs");
mkdirSync(LOG_DIR, { recursive: true });

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Streaming input: each pushed message becomes the next user turn.
const pending: SDKUserMessage[] = [];
let wake: (() => void) | null = null;
async function* inputs(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (pending.length) yield pending.shift()!;
    await new Promise<void>((r) => (wake = r));
  }
}
function send(text: string) {
  pending.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  wake?.();
}

function describe(tool: string, input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.url ?? input.pattern ?? "";
  return `${tool}${detail ? ` ${String(detail)}` : ""}`;
}

const q = query({
  prompt: inputs(),
  options: {
    cwd: process.cwd(),
    model: DEFAULT.model,
    effort: DEFAULT.effort,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    canUseTool: async (tool, input, { suggestions }) => {
      const answer = (await rl.question(`\n? Allow ${describe(tool, input)} [y/N/a=always] `)).trim().toLowerCase();
      if (answer === "a") return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
      if (answer === "y") return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "Denied by the user" };
    },
  },
});
const stream = q[Symbol.asyncIterator]();

function render(msg: SDKMessage) {
  if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
    const e = msg.event;
    if (e.type === "content_block_delta" && e.delta.type === "text_delta") process.stdout.write(e.delta.text);
  } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
    for (const block of msg.message.content) {
      if (block.type === "tool_use") console.log(`\n  > ${describe(block.name, block.input as Record<string, unknown>)}`);
    }
  }
}

let busy = false;
rl.on("SIGINT", () => {
  if (busy) void q.interrupt();
  else rl.close();
});
rl.on("close", () => process.exit(0));

const history: Exchange[] = [];
let current = DEFAULT;
let sessionCost = 0;

for (;;) {
  const input = (await rl.question("\n> ")).trim();
  if (!input) continue;
  if (input === "/exit") break;

  let routerCost = 0;
  try {
    const r = await route(input, history);
    current = r.decision;
    routerCost = r.costUsd;
  } catch (err) {
    console.log(`(router unavailable, keeping ${current.model}/${current.effort}: ${(err as Error).message})`);
  }
  console.log(`[${current.model} / ${current.effort}] ${current.reason}\n`);

  await q.applyFlagSettings({ model: current.model, effortLevel: current.effort });
  busy = true;
  send(input);

  let result = "";
  for (;;) {
    const { value: msg, done } = await stream.next();
    if (done) process.exit(0);
    render(msg);
    if (msg.type !== "result") continue;
    if (msg.subtype === "success") result = msg.result;
    else console.log(`\n(error: ${msg.subtype})`);
    const turnCost = msg.total_cost_usd - sessionCost;
    sessionCost = msg.total_cost_usd;
    console.log(`\n\n[${current.model}/${current.effort} | turn $${turnCost.toFixed(4)} + router $${routerCost.toFixed(4)} | session $${sessionCost.toFixed(4)}]`);
    appendFileSync(
      join(LOG_DIR, "routing.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), input: input.slice(0, 500), ...current, turnCost, routerCost }) + "\n",
    );
    break;
  }
  busy = false;
  history.push({ user: input, assistant: result, decision: current });
}
rl.close();
