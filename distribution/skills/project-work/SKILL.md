---
name: foursday-project-work
description: Complete a new project question or reversible work request through a general evidence-first Agent Loop.
---

# Foursday project work

1. Read the routed project's own instructions before acting.
   - When personal-memory context is absent, call `foursday_read_project_memory`; never guess a gbrain slug or source.
2. Distinguish current authoritative files from archives, smoke runs, derived reports, and historical artifacts.
   - For an aggregate business metric, search for the project's own declared default scope or metric definition before calculating. Do not narrow the scope from the project display name; if a current authoritative document declares a default, use it and disclose its components and exclusions.
   - For every production-quantity answer, scan the evidence for an input/source total. When one exists, report both the source total and the produced total with their layer names and state that they cannot be added; a qualitative warning alone is not enough. Apply the same explicit-value rule to easily confused QA, release, and historical totals.
3. Use tools to inspect and calculate; do not rely on a remembered total when current evidence is available. Images arrive as `localImage`; for other DWS files call `foursday_list_attachments`, then `foursday_stage_attachment`, and inspect the returned `.foursday-inbox/` path without committing it.
   - For the current Foursday version, mode, send gate, event readiness or runtime health, use the connector-provided authoritative live snapshot when present; otherwise call `foursday_runtime_status`. Never answer a current runtime-status question from gbrain, prior Thread history, README, release notes or remembered values. If neither live source is available, say the live status cannot be confirmed.
   - Use `$PYTHON` for Python scripts; it points to the read-only Hermes-managed runtime admitted by the Foursday permission profile.
4. For documents or code, change only the requested project scope, then run the relevant validation and read the result back.
5. Cite exact project-relative evidence and report uncertainty or missing coverage explicitly.
6. End with the outcome, verification, remaining risk, and a recoverable rollback action.
7. Stop at the independent boundary for push, merge, deployment, production writes, irreversible deletion, payments, contracts, HR decisions, secrets, or irreversible commitments.
8. Reuse the bound Codex Thread across follow-ups and restarts. Fork or delegate only inside the same project and permission boundary, then merge evidence back into the parent result.
   - The parent remains responsible for completion: wait for child results, verify them, finish every remaining requirement, and produce the only user-visible final answer. A child final message is evidence, never the task's final response.
9. Ask the requester only for irreducible business meaning or acceptance. Owner-only authority is not a clarification: complete reversible preparation and stop at the independent high-risk exit.
10. Owner communication takeover suppresses stale replies without automatically cancelling useful analysis; explicit task takeover cancels the turn and child work.

Do not create a new capability, adapter, business metric, JSON pointer, or fixed reply template for the current question.
