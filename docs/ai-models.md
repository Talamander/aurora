# AI models, per-job routing and spend

Aurora uses an AI for several different jobs. Some are hard (writing a connector), most are small
(deciding whether a post matches a rule). You can give each job its own model, run the small ones
on a free model on your own computer, and see what the AI costs.

Everything here lives in **AI settings** (the AI button, or ask "open AI settings"), which has three
tabs: **Setup** (the main provider, as before), **Models & jobs** and **Spend**.

## Models on this computer

When the Models & jobs tab opens, Aurora sends one short request to each of three fixed addresses
on this computer and lists what answers:

| Server            | Address checked                    | Endpoint Aurora uses        |
|-------------------|------------------------------------|-----------------------------|
| Ollama            | `http://127.0.0.1:11434/api/tags`  | `http://127.0.0.1:11434/v1` |
| LM Studio         | `http://127.0.0.1:1234/v1/models`  | `http://127.0.0.1:1234/v1`  |
| llama.cpp server  | `http://127.0.0.1:8080/v1/models`  | `http://127.0.0.1:8080/v1`  |

It only ever checks the loopback address. It never scans your network, takes no address from the
browser, does not follow redirects and gives up after 0.7 seconds. On a hosted (cloud) Aurora the
check is skipped, since there is no computer of yours to look on.

Each model gets a **Use for…** menu: pick a single job, or **All small jobs** (AI rules, alerts,
article summaries, briefs and Your week). Nothing is sent to a local model until you choose one.

No server running? Install [Ollama](https://ollama.com) and pull a model, for example
`ollama pull qwen3:8b` (about 5 GB) for the small jobs.

## Who does what

| Job                     | What it does                                                          | Small local model (7 to 14B) |
|-------------------------|-----------------------------------------------------------------------|------------------------------|
| Chat                    | Answers you and changes the app, with tools                           | Fair. Needs reliable tool calling; a 30B-class model works, small ones lose track. |
| Connector builds        | Writes, tests and repairs connectors                                  | Weak. Use a strong model; small local models rarely finish a build. |
| AI rules                | Labels each new post for your plain-English rules                     | Good. Short yes or no judgements. |
| Alerts                  | Decides whether a new post matches an alert                           | Good. |
| Your week               | Writes the weekly paragraph                                           | Fair. Fine, larger models read better. |
| Article summaries       | Summarises and explains articles when you ask                         | Good, given a long enough context window. |
| Briefs and suggestions  | Morning edition, catch-up card, person lines, taste suggestions       | Good. |

**Default** means the job follows the Setup tab, exactly as before this feature: the chat model for
chat and briefs, the builder model for builds, and Claude Haiku for AI rules, alerts and person lines when Claude is
the provider. Routes are saved in the `ai.routes` setting.

### Keys

A key saved in AI settings is only ever sent to the service it was saved for:

- A job on a local server gets no key at all.
- A job on another OpenAI-compatible endpoint gets the saved key only when that endpoint is the one
  on the Setup tab.
- A Claude job gets the saved Claude key when Claude is the main provider. Otherwise it uses only
  `ANTHROPIC_API_KEY` from the environment or the Claude Code login on this computer.

Keys stay encrypted with `data/secret.key`, as before. Routing never adds or enables a paid service
by itself.

## Spend

Every model call writes one row to `data/spend.db` (its own small file, mode 0600): the time, the
job, the provider, the model, input and output tokens, and the cost the provider reported. Nothing
from your posts is stored there; builds and chats keep only the thread id and title.

- **Claude** reports a cost for every call. With the Claude Code login it is the SDK's estimate of
  what the same work would cost on the API, not a bill.
- **OpenRouter** reports a cost and it is recorded.
- **Other hosted OpenAI-compatible services** usually do not; those calls are counted, with tokens,
  and marked as "did not report a cost".
- **Local models** always count as $0.

The Spend tab shows today, this week (from Monday) and this month, a 30-day strip, this month by job
and by model, and the most expensive connector builds of the last 90 days.

Ask the chat too: "how much has the AI cost me this week?" calls the `ai_spend` tool.

### Monthly caps

Each background job can have a soft monthly cap in dollars (the `ai.caps` setting). When a job's
spending this month reaches its cap:

- that job pauses until the first of next month, or until you raise or clear the cap;
- the app shows a banner once ("AI rules paused. This month's AI spending cap is reached.") that
  opens the Spend tab;
- AI rules, alerts, Your week and briefs pause; connector builds pause only for automatic repairs.

A chat you start, a connector you ask for and an article summary you ask for are never paused.
Calls to a local model are free, so a cap never stops them: a $0 cap means "local models only" for
that job. The cap is soft: a call already running finishes, so spending can go slightly over.

## Limits

- A call that fails part way is not recorded, so failed runs can under-count.
- Background jobs still need the main provider on the Setup tab to be ready before they run.
- The MCP server (`docs/mcp.md`) runs inside your own MCP client and is not counted.
