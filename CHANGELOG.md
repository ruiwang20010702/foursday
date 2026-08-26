# Changelog

## Unreleased

- Added current-organization direct-message admission, context-bound DingTalk document links, shared DWS command locking, and explicit busy/unavailable/read-failed diagnostics without exposing DWS to the Codex shell.
- Replaced the flat project/workspace identity with a backward-compatible v2 work-scope registry: Codex can select one executable primary scope plus related scopes and personal-gbrain project evidence, while related context never expands filesystem permission.
- Added bounded personal-gbrain project discovery, v2 session bindings, parent-scope inheritance, stricter path/source validation, and real Codex App Server regression coverage for evidence-bound scope selection.
- Hardened checkpoint, manual-reply probe, deferred-reply, event-wake, rendering read-back, attachment, and enterprise-ingress behavior while keeping production writes and gbrain promotion independently gated.
- Decoupled Sidecar transport readiness from a slow enterprise startup reconcile, kept failed initial scans alive for bounded retry, and extended Shadow/restart health waiting without treating transport connection as checkpoint success.
- In enterprise mode, limited explicit history fetches to the owner's self-chat so current-organization coworkers use one verified enterprise scan instead of redundant per-user scans; preserved safe target diagnostics for enterprise failures.
- Added one bounded retry for an explicitly incomplete enterprise search projection; timeouts, authentication failures, unknown send outcomes, and a second incomplete result still fail closed.
- Moved enterprise global scans ten seconds behind the live projection edge while preserving overlapping checkpoints, preventing persistent `scan_incomplete` without accepting partial results or adding a long fixed delay.
- Split broad enterprise history windows into complete two-minute slices and deduplicated by stable message ID, so a ten-minute reconcile no longer exceeds DWS's 500-item page-all boundary.
- Isolated sender-identity admission failures from organization-wide checkpoint health: unverified senders stay outside the Agent Loop and are retried only through the existing overlap window instead of blocking every trusted conversation.
- Applied the same single bounded retry to idempotent enterprise read-command failures, while authentication failures and a second timeout/command failure still stop checkpoint advancement.
- Made message-resource detail enrichment best-effort after one retry: text remains available with an explicit unavailable marker, no attachment is fabricated, and media download failures still remain unconsumed for retry.

## 0.8.0-rc.1 - 2026-08-24

- Added one revision-fenced Foursday Control service for privacy-safe status, tasks, schedules, project-memory scope, evidence, pause, takeover, correction, and resume.
- Added thin Codex and Claude plugin packages that launch the same Control MCP instead of depending on the legacy 9465 administration API.
- Restored standard Codex and Claude marketplace manifests so both agent-host plugins can be installed from the repository without reviving the legacy plugin implementation.
- Added a square Foursday brand icon and declared it for the Codex composer, light logo and dark logo surfaces.
- Added an optional `foursday dashboard` loopback-only, GET-only status page with no independent state or write endpoint.
- Wired global/task controls into DWS message intake, owner intervention, pre-send generation checks, and explicit post-processing acknowledgements.

## 0.7.0-rc.1 - 2026-08-21

> **Breaking preview:** this release intentionally removes the legacy custom Runtime, configuration keys, migration history, admin UI, plan/capability workflow, and compatibility release tooling. Existing `0.6.x` installations should remain pinned until they are reconfigured as a fresh Foursday Profile; rollback means restoring the previous release rather than applying this candidate's minimal PostgreSQL schema in place.

- Made Codex the only work-planning, tool-calling, and final-response Agent Loop; the embedded upstream runtime now supplies only Gateway, Session, scheduling, and future channel infrastructure.
- Added an install-time locked-source contract check and disabled upstream built-in memory, memory/skill nudges, background-review forks, automatic title generation, and the curator so no auxiliary model or Agent Loop runs after a Codex turn.
- Removed the headless control plane's duplicate approval decision; Foursday's App Server proxy now exclusively auto-reviews reversible work and blocks escalation/high-risk requests, preventing safe commands from being declined as “no capability.”
- Added a Foursday App Server policy proxy that forces registered workspaces on both thread and turn requests, strips caller permission/config/environment overrides, uses a no-network permission profile, denies escalation, and deterministically blocks destructive or externally consequential commands.
- Split the App Server and project-shell environments so DWS identities, business configuration, proxy settings, database names, and secret-bearing variables cannot reach project commands.
- Added a Codex-visible Foursday MCP with short-lived message-bound project/session tokens and no raw requester identity in the token store.
- Added an explicit Profile/project/gbrain context bridge for Codex because the embedded `codex_app_server` adapter does not forward its own ephemeral system prompt; context is private, short-lived, workspace-bound, data-labeled, and stripped before the user request is processed.
- Bound project routing to the embedded runtime's public Session-CWD context so the Codex App Server actually starts inside the selected real workspace rather than merely receiving a project label.
- Added an isolated Foursday `CODEX_HOME` and explicit `foursday login`; user Codex credentials and settings are never copied.
- Added `foursday verify`, a real-model ephemeral shadow check that requires project-tool evidence and an unchanged workspace digest without sending, production writes, or deployment.
- Changed public commands, documentation, visuals, and the source distribution namespace to Foursday-only product language while retaining transparent upstream attribution in technical metadata.
- Added verified post-install pruning of optional Node dependency trees; an isolated macOS install measured 454 MB after pruning versus 1.8 GB before pruning, while preserving runtime and plugin-doctor read-back.
- Bound install and activation to a clean immutable runtime checkout, permitting only the official installer's known contributor-email stamp and rejecting all code drift or hidden Git index flags.
- Rebased Foursday on the native Hermes Profile architecture.
- Removed the custom Agent Runtime, Hermes fork patch, managed Gateway, capability-manifest workflow, approval UI, legacy installers, compatibility release tooling, and duplicate historical documentation.
- Reduced the public CLI to install, configure, login, verify, Gateway, acceptance, and status commands.
- Replaced the legacy configuration surface with a minimal `FOURSDAY_*` contract.
- Reduced PostgreSQL to the encrypted personal-memory promotion queue in `db/schema.sql`.

Earlier implementation history remains available in Git tags and commits; it is intentionally not documented as current behavior.
