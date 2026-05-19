# terragrunt-plan

Parses the noisy output of `terragrunt run --all plan` and produces a clean summary — as a GitHub Step Summary, a PR comment, or both.

Filters out init logs, "No changes" modules, and terraform boilerplate. Only shows modules with real infrastructure changes, sorted by impact (destroys first).

## Output example

> ## Terragrunt Plan
>
> **2 module(s) with changes** — 1 to add, 1 to change, 0 to destroy
>
> | Module | +Add | ~Change | -Destroy |
> |--------|:----:|:-------:|:--------:|
> | `messaging/service-buses/consumption/queues` | 0 | **~1** | 0 |
> | `network/dns-ns-records/new-zone` | **+1** | 0 | 0 |
>
> ---
>
> 🟡 `messaging/service-buses/consumption/queues` — 0 to add, 1 to change, 0 to destroy
>
> <details>
>
> ```hcl
> Terraform will perform the following actions:
>   # azurerm_servicebus_queue.this["export_queue"] will be updated in-place
>   ~ resource "azurerm_servicebus_queue" "this" {
>       ~ lock_duration = "PT5M" -> "PT10M"
>         name          = "export_queue"
>     }
> Plan: 0 to add, 1 to change, 0 to destroy.
> ```
>
> </details>

## Usage

```yaml
- name: Plan all
  run: |
    echo "machine github.com login x password ${GITHUB_TOKEN}" > ~/.netrc
    terragrunt run --all plan 2>&1 | tee /tmp/tg-plan.txt
  env:
    GITHUB_TOKEN: ${{ secrets.BOT_GITHUB_TOKEN }}
  working-directory: northeurope

- name: Summarize plan
  id: diff
  uses: your-org/terragrunt-plan@v1
  with:
    log_file: '/tmp/tg-plan.txt'
    token: ${{ secrets.GITHUB_TOKEN }}
    mode: 'both'
```

> **Note:** `2>&1` is required — terragrunt writes its structured logs to stderr.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `log_file` | ✅ | — | Path to the captured `terragrunt run --all plan` output |
| `token` | — | `''` | GitHub token. Required for `comment` and `both` modes |
| `mode` | — | `both` | `summary` · `comment` · `both` |

## Outputs

| Output | Description |
|--------|-------------|
| `has_changes` | `"true"` if any module has changes, `"false"` otherwise |
| `changes_json` | JSON array: `[{ "module": "...", "toAdd": 0, "toChange": 1, "toDestroy": 0 }]` |

Use `has_changes` to gate a downstream apply step:

```yaml
- name: Apply
  if: steps.diff.outputs.has_changes == 'true'
  run: terragrunt run --all apply --terragrunt-non-interactive
  working-directory: northeurope
```

## PR comment behaviour

When `mode` is `comment` or `both`, the action posts a comment on the open PR. On re-runs it **updates the same comment** instead of creating a new one.

Requires `pull-requests: write` permission on the job:

```yaml
jobs:
  plan:
    permissions:
      contents: read
      pull-requests: write
```

## Log format

The action understands the structured format emitted by `terragrunt run --all`:

```
21:58:59.883 STDOUT [module/path] terraform: <terraform output>
21:58:59.842 INFO   [module/path] terraform: <terragrunt info>
```

Only `STDOUT` lines are processed. `INFO`, `STDERR`, and `WARN` lines (provider downloads, init output, etc.) are discarded.

## Full workflow example

```yaml
name: Terragrunt Plan

on:
  pull_request:
    branches:
      - master

jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Setup terragrunt
        uses: gruntwork-io/terragrunt-action@v2
        with:
          tf_version: 'latest'
          tg_version: 'latest'

      - name: Plan all
        run: |
          echo "machine github.com login x password ${GITHUB_TOKEN}" > ~/.netrc
          terragrunt run --all plan 2>&1 | tee /tmp/tg-plan.txt
        env:
          GITHUB_TOKEN: ${{ secrets.BOT_GITHUB_TOKEN }}
        working-directory: northeurope

      - name: Summarize plan
        id: diff
        uses: your-org/terragrunt-plan@v1
        with:
          log_file: '/tmp/tg-plan.txt'
          token: ${{ secrets.GITHUB_TOKEN }}
          mode: 'both'

      - name: Apply (manual trigger only)
        if: github.event_name == 'workflow_dispatch' && steps.diff.outputs.has_changes == 'true'
        run: terragrunt run --all apply --terragrunt-non-interactive
        working-directory: northeurope
```

## Development

```bash
npm install
npm run package   # bundles to dist/index.js via ncc
```
