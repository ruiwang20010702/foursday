# Install and run

> Current release: `v0.8.0-rc.1`. This is a breaking preview, not an in-place upgrade for the legacy `0.6.x` Runtime. For the production cutover, rollback, and single-writer checklist, see the [Chinese production migration runbook](../指南/生产迁移与回滚.md).

## 1. Install Foursday

```bash
git clone https://github.com/ruiwang20010702/foursday.git
cd foursday
npm ci --ignore-scripts
npx --no-install foursday install
npx --no-install foursday install --apply
```

The first command is a zero-write preview. `--apply` verifies a pinned upstream runtime, skips browser, Computer Use and bundled skills, then moves four optional Node dependency trees aside. Foursday deletes those backups only after the runtime version, plugin doctor and Git tracking checks still pass; failure restores them. A clean reference installation measured 454 MB after pruning versus 1.8 GB before pruning. The first install still runs the upstream dependency step, so download time is not yet reduced. It does not start a Gateway.

## 2. Prepare private configuration

Create private `600`-permission copies of:

- [`deploy/foursday.example.json`](../../deploy/foursday.example.json)
- [`distribution/projects.example.json`](../../distribution/projects.example.json)

Secrets must remain `env://` or `keychain://` references. Project roots must be absolute canonical paths.

DWS `v1.0.59+` is required for the primary personal-IM Stream wake-up. Older DWS versions remain functional through filesystem wake-up and the bounded fallback, but must be reported as degraded. The recommended defaults are a 30-second fallback, an 8-second outbound stability window and a 20-second adaptive maximum; none of these settings expands the allowlist or enables sending.

## 3. Configure Foursday and sign in to its isolated Codex environment

```bash
FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json \
  npx --no-install foursday configure --apply --registry /absolute/private/projects.json

FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json \
  npx --no-install foursday login --apply

FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json \
  npx --no-install foursday verify

FOURSDAY_CONFIG_FILE=/absolute/private/foursday.json \
  npx --no-install foursday verify --apply
```

Add `--cron` only when gbrain writes are enabled and the memory-promotion queue schema has been installed. Login uses a private Foursday `CODEX_HOME`; it does not copy the user's `~/.codex` credentials. `verify` previews first, then runs one real read-only Codex turn in an ephemeral fixture; it requires project-tool evidence and proves the fixture digest is unchanged. It never sends a message, writes production data, or deploys. Configuration always starts at `shadow/send=false`.

## 4. Start shadow mode

```bash
npx --no-install foursday gateway install-shadow --apply
npx --no-install foursday gateway start-shadow --apply
npx --no-install foursday status
```

Shadow mode can receive, route, reason, call tools, and record evidence, but the DWS bridge refuses real sends.

Before activation, verify that the event consumer reached its explicit `[event] ready` state or that the fallback state is visible, then test three message fragments spaced 5–8 seconds apart. Exactly one final reply may become send-eligible; superseded generations must remain unsent.

Operate from Codex/Claude through the packaged Control MCP, or inspect the same state from the CLI:

```bash
npx --no-install foursday control status
npx --no-install foursday control tasks
npx --no-install foursday dashboard
```

The optional dashboard binds only to `127.0.0.1:9466` by default and is read-only. It does not depend on the removed legacy 9465 administration service.

## 5. Activate

Generate an acceptance receipt from bounded shadow evidence:

```bash
npx --no-install foursday accept \
  --release-sha <40-char-commit> \
  --ledger /private/shadow.jsonl \
  --restart-evidence /private/restart.json \
  --code-evidence /private/code.json \
  --output /private/acceptance.json \
  --apply
```

Preview activation to obtain the derived confirmation, then apply the exact same receipt and commit:

```bash
npx --no-install foursday gateway activate \
  --acceptance /private/acceptance.json \
  --release-sha <40-char-commit>
```

Activation is intentionally not part of installation. It refuses a stale or incomplete receipt, a changed Profile or Hermes checkout, a mismatched commit, or another known writer still running.

The GitHub Release does not deploy production. A production cutover requires a separate authorization, a new isolated database, a private Profile/config backup, send-disabled shadow evidence, and an exact read-back. Do not apply `db/schema.sql` to a legacy `0.6.x` production database.

## Stop or remove

```bash
npx --no-install foursday gateway stop --apply
npx --no-install foursday gateway remove-profile
```

`stop` restores `shadow/send=false` before disabling the service. `remove-profile` is a preview until the exact displayed confirmation and `--apply` are supplied. The embedded control plane, personal gbrain, and private configuration are preserved.
