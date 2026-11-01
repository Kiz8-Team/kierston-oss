# Run browser

From the repository root:

```sh
bun run runs-ui
```

Open http://127.0.0.1:8788. Set `PORT=8790` to use a different port.
Requires Bun; no frontend dependencies or build step.

The page reads `kierston_bench/runs` through a read-only local server, reusing
the benchmark CLI's inventory and scoring metadata. `r` reloads from disk.
Scoring stays a separate step (`bun run bench score <series>/<run id> --write`).

## Layout

Three panes: runs, tasks, and the task itself. A run opens on its overview
(family means, run facts); `Overview` at the top of the task list returns to
it. `⇤` in the task header hides both rails so the transcript takes the whole
window, keys `1` and `2` toggle them one at a time; the choice is remembered.
Only the pane you are reading scrolls.

Rows say only what is unusual: a run shows its state when it is not complete,
a task shows its status in place of a score when it has none. Task search
matches the id and the status, so `timeout` or `error` filters to those.

Task tabs: **Transcript** (the agent's turns), **Answer** (score, issues,
notes, answer, metrics), **KDI** (every `kdi` call with timing and output
size; a failing call says its exit code), **Files** (everything on disk,
including the prompt and console logs).

## Transcript

Events are parsed rather than dumped. Each entry is one turn: the prompt, a
thinking block, a tool call paired with its result, or the agent's own text.
Tool calls show the command, with every JSON value in the output
pretty-printed — whole documents, JSON per line, and JSON sitting between a
shell banner and a truncation note alike; text around it, and JSON already
written over several lines, is left as it was — how long the call took, and how
much output came back; where the agent's own harness clipped the output, the
entry says so and names the file it was clipped to. Reasoning that a provider
returns encrypted is labelled as such instead of appearing blank. Prompts and
thinking start folded, tool calls open; long output clips with `Show all`.
Each kind of turn has its own shape: the agent's text is open prose, thinking
an indented aside, a tool call a framed block holding the command and its
output. Click an entry's header to fold it; hovering shows its offset from the
session start. The page follows the system light or dark theme.

The toolbar filters by content, toggles thinking, tool calls and the raw event
JSON, and folds or unfolds everything. Nested session directories each get an
entry in the transcript picker.

## Keys and links

`j`/`k` move through tasks, `/` focuses the filter, `r` reloads from disk,
`1`/`2` toggle the rails, `3`–`6` switch tabs. The URL hash holds
`#series/run/task/tab`, so a reload returns to the same place and the link can
be handed to someone else.

## Files

File previews show the first 2 MiB; `Download full file` retrieves everything.
JSON and JSONL are pretty-printed. Binary files are best downloaded. Missing
answers, scores, and logs are shown explicitly. Run state follows the CLI's
filesystem-based heuristic; it is not a live process check.

The server binds to loopback, accepts GET only, and confines artifact access to
the selected run/task, including resolved symlinks. It does not dispatch or
score runs, change artifacts, or require an external service. Open through the
server, rather than opening the HTML with a file URL.

Checks: `bun test tools/run-browser/server.test.ts`.
