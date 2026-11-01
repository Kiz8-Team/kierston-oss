# Other models and agents

| Goal | Method |
| --- | --- |
| Model supported by pi | `--model <provider>/<model>` and `--env <provider key>` |
| Custom pi provider | Define it in `models.json` in an agent directory, pass `--agent-dir`, pass its key with `--env` |
| Different agent | Build an image that follows the agent contract, run with `--image <tag>` and, if needed, `--startup-command` |

## Providers

Providers checked by preflight ([`kierston_bench/bench_cli/src/preflight.ts`](../../kierston_bench/bench_cli/src/preflight.ts)):

| Provider | Key variables |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN` |
| `openai` | `OPENAI_API_KEY` |
| `openai-codex` | `--agent-dir` sign-in only |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` |
| `google`, `gemini`, `google-gemini-cli`, `google-antigravity` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| `opencode`, `opencode-go` | `OPENCODE_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `minimax`, `minimax-cn` | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |

Other `--env` variables are passed through as custom provider keys.

## Agent contract

Requirements for a custom agent image:

| Item | Requirement |
| --- | --- |
| Start | Image command, or the startup command under `bash -c` |
| Input | Case file at `$ETF` (`/input/input.json`). Shared context in `$EC` |
| Data access | `adi`, `km_search_places`, `km_address_lookup` only. They call the KDI service at `$AU` with capability `$AT` |
| Files | Work in `/work`. Logs in `/out/logs` (`$ELD`) |
| Output | Write `/out/answer.json` as `{"answer", "notes"}`, then exit |
| Deadline | `$ED` in milliseconds. The container is killed after the grace period. The answer file at that point is used |
| Environment | Unset the `E*` variables before the model starts |

Minimal example image: [`kierston_bench/eval_runner/agents/example/`](../../kierston_bench/eval_runner/agents/example).
Full contract: [`kierston_bench/agent_eval_runtime/README.md`](../../kierston_bench/agent_eval_runtime/README.md).

## Model-visible text

All text the model can see (prompts, context, tool help) is in
[`kierston_bench/model_visible_text.ts`](../../kierston_bench/model_visible_text.ts).
Inside the container, KDI is called ADI (Allentown Data Interface). Model-visible
text must not contain "Kierston" or any reference to evaluation. A custom
startup command must follow the same rule.
[`kierston_bench/eval_runner/test/model_visible_text.test.ts`](../../kierston_bench/eval_runner/test/model_visible_text.test.ts) checks this.
