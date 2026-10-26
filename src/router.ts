import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { EFFORTS, MODELS as MODEL_IDS, PROJECT_RULES_FILE, ROUTING_RULES, promptSignals, withProjectRules } from "../plugin/hooks/rules.ts";

const MODELS = Object.keys(MODEL_IDS) as (keyof typeof MODEL_IDS)[];
export type Model = keyof typeof MODEL_IDS;
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

const SYSTEM = `${ROUTING_RULES}
- reason: one short sentence, in the language of the prompt.`;

function readProjectRules(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), PROJECT_RULES_FILE), "utf8");
  } catch {
    return undefined;
  }
}

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
    prompt: `${context ? `Recent conversation:\n${context}\n\n` : ""}Prompt signals: ${promptSignals(prompt)}\n\nNew prompt to route:\n${prompt}`,
    options: {
      model: "haiku",
      effort: "low",
      systemPrompt: withProjectRules(SYSTEM, readProjectRules()),
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
