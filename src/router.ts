import { query } from "@anthropic-ai/claude-agent-sdk";

export const MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];

export type Decision = { model: Model; effort: Effort; reason: string };
export type Exchange = { user: string; assistant: string; decision: Decision };

const SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string", enum: MODELS },
    effort: { type: "string", enum: EFFORTS },
    reason: { type: "string" },
  },
  required: ["model", "effort", "reason"],
  additionalProperties: false,
};

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
- reason: one short sentence, in the language of the prompt.`;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

export async function route(
  prompt: string,
  history: Exchange[],
): Promise<{ decision: Decision; costUsd: number }> {
  const context = history
    .slice(-3)
    .map(
      (e) =>
        `USER: ${clip(e.user, 400)}\nROUTED: ${e.decision.model}/${e.decision.effort}\nASSISTANT: ${clip(e.assistant, 400)}`,
    )
    .join("\n\n");

  const q = query({
    prompt: `${context ? `Recent conversation:\n${context}\n\n` : ""}New prompt to route:\n${prompt}`,
    options: {
      model: "haiku",
      effort: "low",
      systemPrompt: SYSTEM,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 3,
      outputFormat: { type: "json_schema", schema: SCHEMA },
    },
  });

  for await (const msg of q) {
    if (msg.type !== "result") continue;
    if (msg.subtype === "success" && msg.structured_output) {
      return { decision: msg.structured_output as Decision, costUsd: msg.total_cost_usd };
    }
    throw new Error(`router failed: ${msg.subtype}`);
  }
  throw new Error("router returned no result");
}
