<div align="center">

![Foursday](./assets/foursday-hero.svg)

# Foursday

**A personal-memory-driven work twin for real projects.**

Trusted message → personal context → real workspace → verified work → natural reply.

[简体中文](./docs/指南/中文首页.md) · [Architecture](./docs/en/architecture.md) · [Install](./docs/en/deployment.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

[![Checks](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml)
[![Security](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml)
[![Release](https://img.shields.io/github/v/release/ruiwang20010702/foursday?include_prereleases&sort=semver)](https://github.com/ruiwang20010702/foursday/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-53a7ff.svg)](./LICENSE)

</div>

## What it does

Foursday is an AI work twin for people who want an agent to work inside their real projects—not a chatbot that needs a new workflow for every question.

For an allowlisted contact, Foursday can:

- understand the conversation and route it to the right project;
- read authorized pages from your personal gbrain;
- use Codex inside the real workspace;
- search, calculate, edit files, run tests, and recover from failures;
- reply naturally with read-back evidence;
- freeze stale outbound text when the owner intervenes, while preserving or stopping background work according to the owner's intent.

Push, merge, deployment, production writes, irreversible deletion, payment, contracts, HR decisions, and secret disclosure remain hard boundaries.

## Architecture

```mermaid
flowchart LR
    M["Personal DingTalk / messaging channels"] --> T["Foursday Gateway + session"]
    T --> R["Foursday trust + project router"]
    G["Personal gbrain"] --> C["Private context"]
    R --> C
    C --> X["Codex Agent Loop"]
    X --> W["Real project workspace"]
    W --> X
    X --> V["Read-back evidence"]
    V --> T
    T --> M
    X --> B{"Sandbox + rules + review"}
    B -->|"reversible"| W
    B -->|"external / irreversible"| O["Blocked / owner-authorized exit"]
```

Foursday uses a pinned, minimally installed [Hermes](https://github.com/NousResearch/hermes-agent) control plane internally; Codex is the only work-planning and reply-generating loop. Foursday ships:

- an isolated `foursday` Profile;
- DWS personal DingTalk and project-router plugins, with Stream event wake-up, filesystem wake-up and bounded fallback;
- an isolated Codex home with an App Server policy proxy, workspace sandboxing, forbidden command rules, automatic approval review, and a Foursday MCP;
- a project-work Skill;
- small host-side bridges for credentials and personal-memory promotion.
- one host-neutral Foursday Control MCP, with thin Codex and Claude plugins plus an optional read-only local status page.

The installation gate verifies that the pinned runtime bypasses its own foreground tool loop in `codex_app_server` mode. Foursday also disables upstream built-in memory, memory/skill nudges, background review, automatic title generation, and the curator; durable learning goes only through the Foursday MCP and personal-gbrain promotion path.

Profile behavior, routed project details, and personal-memory context are explicitly bridged into Codex rather than assumed to flow through the embedded runtime. A private 15-minute token binds each turn to one workspace and Session; the proxy removes the internal marker before reasoning, labels gbrain text as data rather than instructions, and prevents the token from leaving in a reply.

The previous custom Agent Runtime, capability manifests, approval UI, managed Gateway, compatibility installer, and duplicated documentation were removed. Git history remains the recovery path.

## Next capability boundary

Foursday uses a Codex-first capability model: Hermes owns message ingress, sessions, cron/event triggers, and delivery; Codex owns thread resume/fork, subagents, shell/Python, web, images, approved MCPs, isolated skills/working memory, project execution, and the final answer. Foursday binds identity, project, workspace, authority, human intervention, receipts, and stable-fact promotion without adding a second work graph or agent loop.

Inside an authorized project, reversible work runs autonomously. Business meaning and acceptance questions go to the requester; production, cross-project access, personal high-authority connectors, secrets, and irreversible actions go to the owner. An owner reply first advances `ownerRevision/sendGeneration`, invalidates stale outbound text, and is then classified as communication takeover, task correction, task takeover, resume, or an unrelated message. Busy text is queued rather than redirected: the Gateway freezes the latest version actually consumed when the main handler returns, and only the final processing-root reply may adopt that snapshot. Intermediate, empty, old, cross-conversation, post-return, or takeover-stale replies remain ineligible to send. The current source candidate implements this contract; real sending and production activation remain separate release gates.

## Install

Requirements: macOS, Git, Node.js 22+, DWS `v1.0.59+` for Stream event wake-up (older versions degrade to filesystem wake-up and bounded fallback), and access to a personal gbrain endpoint.

```bash
git clone https://github.com/ruiwang20010702/foursday.git
cd foursday
npm ci --ignore-scripts
npx --no-install foursday install
npx --no-install foursday install --apply
```

`foursday install` verifies the pinned upstream installer, skips browser, Computer Use and bundled skills, then atomically prunes optional Node dependency trees only after the runtime and plugin doctor still pass. On the reference macOS host this reduced the installed runtime from 1.8 GB to 454 MB; the first install is still limited by the upstream dependency-install time. It does not start a Gateway or send a message.

Then create private copies of:

- [`deploy/foursday.example.json`](./deploy/foursday.example.json)
- [`distribution/projects.example.json`](./distribution/projects.example.json)

Configure and start in send-disabled shadow mode:

```bash
FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json npx --no-install foursday configure --apply --registry /absolute/private/projects.json
FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json npx --no-install foursday login --apply
FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json npx --no-install foursday verify --apply
npx --no-install foursday gateway install-shadow --apply
npx --no-install foursday gateway start-shadow --apply
```

Activation is deliberately separate and requires a current shadow-acceptance receipt bound to the exact Foursday commit. See [deployment](./docs/en/deployment.md).

`foursday verify` runs one real Codex turn against an ephemeral fixture. It requires tool evidence, checks an unpredictable fact token, proves the workspace digest is unchanged, and performs no DingTalk send, production write, or deployment.

## Operate from Codex or Claude

Foursday is operated from an installed agent host, not from a separate administration product. Both plugin packages call the same local Control MCP:

- [`plugins/foursday`](./plugins/foursday)
- [`distribution/claude-plugins/foursday`](./distribution/claude-plugins/foursday)

Install either or both agent-host entries from the cloned repository:

```bash
npm install --global --ignore-scripts .

codex plugin marketplace add .
codex plugin add foursday@foursday-local

claude plugin marketplace add . --scope user
claude plugin install foursday@foursday-local --scope user
```

Start a new Codex task or Claude Code session after installation so the new Skill and MCP are discovered. Both hosts use the installed `foursday` CLI; they do not bundle a second runtime.

The Control MCP exposes privacy-safe status, tasks, schedules, project-memory scope and evidence. Pause, takeover, correction and resume require the exact current `revision`; they cannot enable sending, deploy, delete data or expand permissions.

The same surface is available from the CLI:

```bash
npx --no-install foursday control status
npx --no-install foursday control tasks
npx --no-install foursday control schedules
```

For occasional visualization, start a read-only loopback page on demand:

```bash
npx --no-install foursday dashboard
# http://127.0.0.1:9466/
```

The page stores no independent state and exposes no write endpoint. Port `9465` belongs to the removed legacy administration runtime and is not a current source of truth. Upgrades may stop and archive the old service, but never remove PostgreSQL, Keychain entries or gbrain data as part of that cleanup.

## Memory ownership

| Store | Responsibility |
|---|---|
| Personal PRIVATE gbrain Git | Durable business knowledge |
| gbrain PostgreSQL | Rebuildable search and graph projection |
| Foursday Session store | Conversation and tool history, provided by the embedded control plane |
| Foursday PostgreSQL | Encrypted memory-promotion queue only |

Foursday does not create a second knowledge repository or copy personal pages into its own Git repository.

## Status

The current public preview is `v0.8.0-rc.1`. It adds the shared Control MCP, Codex/Claude plugins, owner intervention fencing, Thread continuity and an optional read-only status page to the one-Codex-loop architecture. It is a release candidate, not evidence that a production instance has been activated.

Installing this repository does not inherit any existing instance's authority, credentials, allowlist, send permission, or production state.

Run the verified checks locally:

```bash
npm run check:full
npm run check:python
npm run reuse:verify
npm run check:security
```

## Documentation

- [Architecture](./docs/en/architecture.md)
- [Deployment](./docs/en/deployment.md)
- [生产迁移与回滚](./docs/指南/生产迁移与回滚.md)
- [Integration guide](./docs/en/integrations.md)
- [产品需求文档](./docs/产品需求文档.md)
- [技术设计文档](./docs/技术设计文档.md)
- [中文首页](./docs/指南/中文首页.md)

## License

[MIT](./LICENSE)
