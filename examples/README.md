# Examples

Runnable code for every page in [`docs/`](../docs/). Each file runs on its own and shows one idea; the docs quote
these files and nothing else. Every file that runs on a server has a Python and a TypeScript twin, and the twins
print the same output.

## Setup

Python 3.11+ with [`uv`](https://docs.astral.sh/uv/), and Node 20.12+.

```bash
cp env.example .env           # at the repository root; put your secret key in LABS_API_KEY
cd examples
uv sync                       # Python: installs pyyaml (getting-started needs nothing beyond the stdlib)
npm install                   # TypeScript: tsx, yaml
```

Run everything from `examples/`. Files the examples write go to `out/` (audio, the knowledge CSV) and
`snapshots/`; ids they create go into `.env`.

## Run any example

```bash
uv run python <folder>/<file>.py
npx tsx <folder>/<file>.ts
```

Every call to Labs prints one line: method, path, status and `X-Credits-Charged`, and the start of the body
when it fails.

### `getting-started/`: one idea per file, in order

| File | Shows | Needs |
|---|---|---|
| `01-verify-key` | Checks the key (free): kind, plan, rate limit, families | `LABS_API_KEY` |
| `02-chat-one-turn` | Opens a chat, asks one question, prints the chat id and the whole answer | `LABS_AGENT_ID` |
| `03-speak-one-line` | One speech call saved to `out/`, with the credit headers | `LABS_VOICE_ID` (else the first public voice) |
| `04-chat-sentences` | The answer one sentence per line, as it arrives | `LABS_AGENT_ID` |
| `05-errors-and-credits` | Forces a 401, Python's default User-Agent and a 429; reads balance and usage | `LABS_AGENT_ID` |
| `06-transcript` | Reads a chat's history back | `LABS_AGENT_ID`, or a chat id |
| `07-voice-agent` | 04 plus speech per sentence, 2 in flight, played in order | `LABS_AGENT_ID` with a voice |

### `site-setup/`: from the owner's answers to a working agent

| File | Shows | Writes |
|---|---|---|
| `site-assistant.example.yaml` | Every answer to the 22 questions, with defaults | — |
| `setup-01-questions` | Asks the 22 questions in four rounds | `site-assistant.yaml` |
| `setup-02-create-agent` | Creates the agent with a voice; speaks the owner's hard words | `LABS_AGENT_ID`, `LABS_VOICE_ID`, `out/hard-words/` |
| `setup-03-build-instructions` | Builds the instructions from the answers and saves them (`--dry-run` to read first) | a flow version |
| `setup-04-knowledge` | Uploads the site's pages with their addresses; refreshes on publish | `LABS_KB_ID`, `out/knowledge.csv` |
| `setup-05-snapshot-restore` | `save`, `list`, `restore <file>`: roll back a change | `snapshots/` |

Without a `site-assistant.yaml` in `examples/`, the setup scripts use `site-setup/site-assistant.example.yaml`
(a fictional bakery) and `site-setup/sample-site/`.

### `speech/`: speech recipes and measurements

| File | Shows | Language |
|---|---|---|
| `speech-cache-key` + `cache-key-vectors.json` | The key for a spoken clip; checks itself against the shared vectors | Py + TS |
| `speech-make-clips` | Makes the welcome and acknowledgement clips once, stored by key in `out/clips/` | Py + TS |
| `speech-respell` | Respells the owner's hard words before speech; before and after clips | Py + TS |
| `speech-sound-alikes` | Puts misheard words back in a transcript; prints the spelling list for the instructions | Py + TS |
| `speech-narrate-page` | Reads a page aloud in short checked parts, cached by the page's text | Py + TS |
| `speech-determinism` | Which voices repeat a line, and which settings each voice takes | Py |
| `speech-ttfb` | Time to the first audio, by line length and format | Py |
| `speech-newline-endtrim` | How clips end, with and without a trailing newline | Py |

### `voice-clone/`: from a recording to a cloned voice (Python)

| File | Shows | Writes |
|---|---|---|
| `clone-00-sample-recording` | A practice two-speaker recording made with public voices | `out/voice-clone/` |
| `clone-01-transcribe` | Transcribes the recording with who spoke when, word by word | `out/voice-clone/` |
| `clone-02-cut` | Keeps one speaker and cuts on real pauses into one sample | `out/voice-clone/` |
| `clone-03-report` | A report on the sample for the owner to approve | `out/voice-clone/` |
| `clone-04-create` | Clones the voice (`--consent`) and speaks test lines in it | a cloned voice |

## From nothing to a talking agent

```bash
uv run python getting-started/01-verify-key.py
uv run python site-setup/setup-01-questions.py --defaults   # or without --defaults, with the owner
uv run python site-setup/setup-02-create-agent.py
uv run python site-setup/setup-03-build-instructions.py
uv run python site-setup/setup-04-knowledge.py
uv run python getting-started/07-voice-agent.py "Are you open on Monday?"
```

Swap any line for its `npx tsx … .ts` twin. To type-check the TypeScript: `npm run typecheck`.

## Clean up

`setup-02` creates an agent and `setup-04` a knowledge base; their ids are in `.env`. `clone-04-create` makes a
cloned voice and prints its id: delete it in the dashboard, or with `DELETE /voice-audio/voices/{voiceId}`, when you no
longer need it. Delete them when you're
done (skip the second line if `LABS_KB_ID` is empty), then empty `LABS_AGENT_ID`, `LABS_VOICE_ID` and
`LABS_KB_ID` in `.env`:

```bash
set -a; . ../.env; set +a; LABS_BASE_URL=${LABS_BASE_URL:-https://api.rezolvelabs.com/api/v1}
curl -s -o /dev/null -X DELETE -H "X-API-KEY: $LABS_API_KEY" -A "curl/8" -w "DELETE agent -> %{http_code} credits=%header{x-credits-charged}\n" "$LABS_BASE_URL/developer-platform/agents/$LABS_AGENT_ID"
curl -s -o /dev/null -X DELETE -H "X-API-KEY: $LABS_API_KEY" -A "curl/8" -w "DELETE knowledge base -> %{http_code} credits=%header{x-credits-charged}\n" "$LABS_BASE_URL/developer-platform/knowledge-bases/$LABS_KB_ID"
```

Each line prints `-> 204` when the delete worked. Empty the ids afterwards: a stale `LABS_KB_ID` makes the next
`setup-04` upload to a deleted knowledge base. Chats need no clean-up: opening one is free.
