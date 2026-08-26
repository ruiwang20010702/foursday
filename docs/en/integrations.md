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

Work scopes may inherit up to 20 common documents (`dingtalkSources`) from their parent scope in the private v2 registry. The registry separates real workspaces from project/subproject scopes; broader relationships come from read-only personal-gbrain discovery and are selected by Codex rather than a fixed manifest classifier. Personal-mode direct-message admission is organization-wide: a global bounded message scan keeps only single chats, then the sender's stable user ID must resolve exactly through the current-organization contact chain. External and unresolved identities are dropped. An exact `alidocs.dingtalk.com/i/nodes/...` link from any verified enterprise sender is extracted before model inference and appears only as an ephemeral `provided_N` source.

Codex sees only context-local source IDs through `foursday_list_project_sources` and reads one exact source through `foursday_read_project_source`. DingTalk node IDs, URLs, DWS credentials, contact/global search, writes and adjacent-node access never enter the project shell. Never probe or invoke `dws` from Codex shell: `project_source_host_busy`, `project_source_host_unavailable`, `project_source_read_failed` and `project_source_not_found` are intentionally distinct. The Sidecar and MCP share one private cross-process DWS command lock. Each DWS command is bounded to eight seconds and 2 MB, while the complete MCP call is bounded to 30 seconds; returned content is capped at 30,000 characters and always marked as untrusted evidence rather than instructions.
