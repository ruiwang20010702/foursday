# Integrations

Use the narrowest Foursday extension surface that fits the job. The distribution maps these contracts onto its embedded control plane internally:

| Need | Extension |
|---|---|
| New messaging platform | Foursday connector |
| Project discovery or context | Profile plugin / Hook |
| Repeatable work method | Skill |
| External application API | MCP server or tool plugin |
| External or irreversible action | Separate owner-authorized exit |

Do not add a capability manifest, business-specific JSON pointer, fixed reply template, second Agent Loop, or control-plane core patch.

An integration is acceptable only when it preserves identity binding, workspace isolation, secret isolation, human takeover, idempotency, unknown-outcome handling, and exact read-back. Add positive, denial, mismatch, retry, restart, and duplicate tests with the implementation.

Agent-host integrations are thin clients of `foursday control-mcp`. They must read the current revision before a control write and must not parse private runtime files or reuse the legacy 9465 API.

The repository is an installable marketplace for both supported hosts:

```bash
npm install --global --ignore-scripts .

codex plugin marketplace add .
codex plugin add foursday@foursday-local

claude plugin marketplace add . --scope user
claude plugin install foursday@foursday-local --scope user
```

The Codex marketplace entry lives at `.agents/plugins/marketplace.json`; the Claude entry lives at `.claude-plugin/marketplace.json`. Both resolve to thin host plugins and require the same installed `foursday` CLI.

Current examples live in `distribution/plugins/` and `distribution/skills/`.

## Project-bound DingTalk sources

Projects may optionally register up to 20 live DingTalk documents in the private project registry. Codex sees only project-local source IDs through `foursday_list_project_sources` and reads one source through `foursday_read_project_source`; DingTalk node IDs, URLs, DWS credentials and arbitrary search never enter the project shell. Reads are direct-message only, read-only, bounded to eight seconds and 30,000 returned characters, and the document body is always marked as untrusted evidence rather than instructions.
