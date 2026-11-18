# Development

## Setup and checks

```bash
npm ci
npm test
npm run typecheck
```

## Source layout

```text
src/
  index.ts     # extension entry: registers the todo tool + /todo command
  binding.ts   # one-time capture of PI_SUBAGENT_EXTENSION_BINDINGS
  namespace.ts # namespace policy (identifiers, caller, scope resolution)
  tool.ts      # action dispatch, validation, tool description
  db.ts        # node:sqlite wrapper: schema, migrations, tree fetch
  paths.ts     # $scope/$name path parsing
  render.ts    # tree → text (truncation-aware) + themed TUI output
  command.ts   # /todo command + namespace-aware TUI viewer
```

## Production dependency installs

Pi supplies its SDK packages and `typebox` at runtime. They remain wildcard
peer dependencies; pinned development copies support standalone tests and
typechecking.

[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) disables automatic peer
installation. This prevents managed production installs from fetching a second
host SDK tree and encountering unrelated dependency build approvals. In the
pnpm 12.4.1 reproduction, Pi's command-line peer-install override alone did not
prevent those installs; the repository-local setting did.

When `pnpm` is available, [`tests/production-install.test.ts`](../tests/production-install.test.ts)
checks Pi's production install command offline in a temporary directory. It
verifies that host SDKs are not installed, without approving or bypassing
dependency build scripts. The check is skipped when `pnpm` is unavailable.
