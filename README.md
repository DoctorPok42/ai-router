# ai-router

Automatic model and effort selection for every prompt in Claude Code.

For each message, Claude Haiku (effort `low`) classifies the request and picks a model / effort pair
(`haiku | sonnet | opus` x `low | medium | high | xhigh | max`). The answer is then produced with that
pair. Simple tasks go to a light model, hard tasks to a powerful one, without juggling `/model` and
`/effort` by hand.

Two integrations are provided:

| | Folder | Usage |
|---|---|---|
| `auto-route` Claude Code plugin (recommended) | `plugin/` | Works wherever Claude Code runs: terminal, VS Code, desktop app, `claude -p` |
| Standalone `ai` CLI | `src/` | Small command-line client built on the Agent SDK |

## Requirements

- Claude Code installed and logged in (`claude --version`)
- Node.js, only for the standalone CLI

## Get the project

```sh
git clone https://github.com/DoctorPok42/ai-router.git
cd ai-router
```

## Claude Code plugin (recommended)

### Installation

`auto-route` installs like any Claude Code plugin. The `plugin/` folder acts as a local marketplace
(manifest `plugin/.claude-plugin/marketplace.json`, marketplace name `ai-router`).

From the `ai-router` folder, in one command:

```sh
claude plugin install auto-route --marketplace "$(pwd)/plugin"
```

Or in two steps, declaring the marketplace first:

```sh
claude plugin marketplace add "$(pwd)/plugin"
claude plugin install auto-route@ai-router
```

By default the plugin is installed for all of the user's sessions (`--scope user`). To restrict it to one
project, add `--scope project` (shared through the project repository) or `--scope local` (only for you in
that project). Check with `claude plugin list`.

The plugin is read directly from this folder: after changing the code, `/reload-plugins` in a session is
enough. To remove it: `claude plugin uninstall auto-route`.

### Usage

- The status line shows the current decision: `auto: opus/xhigh - <reason>`.
- `/auto-route off` gives control back to `/model` and `/effort`, `/auto-route on` turns it back on,
  `/auto-route` toggles.
- `/auto-route log` shows a summary of the recorded decisions (count per model/effort, last 5).
- Plain acknowledgements (`ok`, `okay`, `go`, `continue`, `yes`, `y`, `oui`, `thanks`, `thank you`, `thx`, `merci`) skip the router
  call and keep the previous decision, which saves latency and cost.
- Slash commands are not routed.
- Subagents keep their own model and effort.
- If Haiku does not answer or answers badly, the previous decision (or the session model) is kept.
  A router failure never blocks the prompt.

### Cost ceilings

The plugin declares two options (set at install time or later in the `/config` menu):

- `maxModel` (`haiku | sonnet | opus`, default `opus`): the router never picks a more capable model.
- `maxEffort` (`low | medium | high | xhigh | max`, default `max`): the router never picks a higher effort.

A decision above a ceiling is lowered to it. The CLI has no such option.

### How it works

The plugin hooks into three Claude Code events (`plugin/hooks/register.ts`):

1. `prompt.submit`: sends the prompt (plus the last 3 exchanges, truncated) to Haiku, which replies with a
   JSON `{model, effort, reason}`. An invalid reply or an unknown model is ignored. Each decision is
   appended to the plugin's own store (last 500 kept, prompts truncated to 500 characters), local to your
   machine.
2. `turn.step`: replaces the model and effort of the main thread with the chosen decision.
3. `command.run`: handles the `/auto-route` command.

The routing rules (which model for which kind of task) live in `plugin/hooks/rules.ts`. It is the only
place to edit to adjust the behavior: the plugin and the CLI both import it.

The model identifiers are in the `MODELS` constant of the same file: update them when new versions ship.

### Tests and validation

```sh
npm test                      # same as: claude plugin test plugin
claude plugin validate plugin
```

## Standalone CLI

```sh
npm install
npm link        # makes the `ai` command available everywhere
cd my-project && ai
```

Without `npm link`: `npm start` from this folder.

- `/exit` or Ctrl+C (at the prompt) to quit, Ctrl+C during a response to interrupt it.
- Tool permissions: `y` = yes, `a` = always for the session, anything else = no.
- Every decision is logged in `logs/routing.jsonl` (input, model, effort, reason, costs).
  This folder is ignored by git: it contains your prompts, do not share it.
- The router cost is displayed on each turn, next to the cost of the answer.

The CLI uses the same routing rules as the plugin (`plugin/hooks/rules.ts`); `src/router.ts` only adds the
output format.

## Structure

```plaintext
ai-router/
├── plugin/                    Claude Code plugin
│   ├── .claude-plugin/        Manifests (plugin.json, marketplace.json)
│   ├── hooks/                 hooks.json, register.ts (logic), rules.ts (routing rules, shared)
│   └── tests/                 Plugin tests
├── src/
│   ├── cli.ts                 CLI interactive loop
│   └── router.ts              Haiku call (rules imported from plugin/hooks/rules.ts)
├── bin/ai                     Entry point of the `ai` command
└── logs/                      CLI decision log (ignored by git)
```

## Development

```sh
npm run typecheck   # checks src/ (the plugin is checked by `claude plugin validate`)
npm test            # plugin tests
```
