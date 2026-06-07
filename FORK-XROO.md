# XRoo — Your Own Build of Roo Code

**XRoo** is the community-maintained, re-branded build of the [Roo Code](https://github.com/RooCodeInc/Roo-Code) VS Code extension, published by **[yuvalhuck](https://github.com/yuvalhuck)**.

This document describes how XRoo is layered on top of the upstream Roo Code monorepo and how to build, install, and publish it.

---

## 1. Why a separate build app?

The upstream codebase already supports a "branded variant" pattern via [`apps/vscode-nightly/`](./apps/vscode-nightly/esbuild.mjs). XRoo follows the same pattern in a parallel app — **`apps/vscode-xroo/`** — so:

- The shared extension code in [`src/`](./src/) is **never modified**, which keeps merging upstream from `RooCodeInc/Roo-Code` low-friction.
- The XRoo extension installs **side-by-side** with the upstream `RooVeterinaryInc.roo-cline` extension and the nightly build — they have different `publisher.name` IDs and different VS Code command namespaces.
- All re-branding (name, display name, publisher, icon, command IDs, output channel, telemetry channel name, etc.) happens at **bundle time** through a substitution string.

## 2. File layout introduced by XRoo

```
apps/vscode-xroo/
├── .gitignore                  # ignores the build/ output
├── package.json                # workspace package; defines bundle:xroo & vsix:xroo
├── package.xroo.json           # identity overrides (name, version, publisher, icon, repo, …)
├── package.nls.xroo.json       # localized display strings for the XRoo brand
├── turbo.json                  # turbo task wiring (bundle:xroo → vsix:xroo)
└── esbuild.mjs                 # the build orchestrator (copies src/, rewrites identity)
```

Plus three light edits to existing files:

| File                                                                         | Change                                                                                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`webview-ui/vite.config.ts`](./webview-ui/vite.config.ts)                   | Added `mode === "xroo"` branch that points `outDir` at `apps/vscode-xroo/build/webview-ui/build` and injects XRoo `PKG_*` defines. |
| [`webview-ui/package.json`](./webview-ui/package.json)                       | Added `"build:xroo": "tsc -b && vite build --mode xroo"`.                                                                          |
| [`webview-ui/turbo.json`](./webview-ui/turbo.json)                           | Added `build:xroo` task with the XRoo output dir.                                                                                  |
| [`package.json`](./package.json) (root)                                      | Added `bundle:xroo`, `vsix:xroo`, `install:vsix:xroo`.                                                                             |
| [`scripts/install-vsix.js`](./scripts/install-vsix.js)                       | Added a `--xroo` mode that reads identity (incl. publisher) from `package.xroo.json`.                                              |
| [`.github/workflows/xroo-publish.yml`](./.github/workflows/xroo-publish.yml) | Manual workflow to build, tag, and publish XRoo to VS Code Marketplace + Open VSX.                                                 |

## 3. Identity (where to change branding)

All XRoo-facing strings live in **two** files. Edit these and rebuild — nothing else needs to change.

### `apps/vscode-xroo/package.xroo.json`

```json
{
	"name": "xroo", // VS Code extension id (lowercase, hyphens)
	"displayName": "XRoo",
	"version": "0.1.0", // bumped per release
	"publisher": "yuvalhuck", // your VS Code Marketplace publisher
	"icon": "assets/icons/icon.png", // path inside the built extension (see §4 to add a custom icon)
	"author": { "name": "yuvalhuck", "url": "https://github.com/yuvalhuck" },
	"repository": { "type": "git", "url": "https://github.com/yuvalhuck/XRoo" },
	"homepage": "https://github.com/yuvalhuck/XRoo",
	"bugs": { "url": "https://github.com/yuvalhuck/XRoo/issues" },
	"license": "Apache-2.0"
}
```

### `apps/vscode-xroo/package.nls.xroo.json`

Localized labels shown in the VS Code UI (activity bar, settings page, etc.):

```json
{
	"extension.displayName": "XRoo",
	"extension.description": "XRoo — a community-maintained build of the Roo Code agent for VS Code, maintained by yuvalhuck.",
	"views.contextMenu.label": "XRoo",
	"views.terminalMenu.label": "XRoo",
	"views.activitybar.title": "XRoo",
	"configuration.title": "XRoo"
}
```

### Command IDs / activity-bar view IDs

These are rewritten **automatically** at bundle time. [`apps/vscode-xroo/esbuild.mjs`](./apps/vscode-xroo/esbuild.mjs) calls `generatePackageJson({ …, substitution: ["roo-cline", overrideJson.name] })`, which walks the `contributes` block of [`src/package.json`](./src/package.json) and rewrites every `roo-cline.*` identifier to `xroo.*` (id of views/containers, command IDs, menu `command`/`when` clauses, submenu IDs, keybindings, configuration keys, etc.).

That means after rebrand:

| Before (upstream)                   | After (XRoo)             |
| ----------------------------------- | ------------------------ |
| `roo-cline.SidebarProvider`         | `xroo.SidebarProvider`   |
| `roo-cline-ActivityBar`             | `xroo-ActivityBar`       |
| `roo-cline.plusButtonClicked`       | `xroo.plusButtonClicked` |
| Config: `roo-cline.allowedCommands` | `xroo.allowedCommands`   |

The runtime `PKG_NAME`, `PKG_VERSION`, and `PKG_OUTPUT_CHANNEL` env vars used by the extension and the webview are also overridden (see `define` blocks in [`apps/vscode-xroo/esbuild.mjs`](./apps/vscode-xroo/esbuild.mjs) and the `xroo` branch in [`webview-ui/vite.config.ts`](./webview-ui/vite.config.ts)). The XRoo output channel name is `XRoo`.

## 4. Custom icon (optional but recommended before publishing)

Today XRoo reuses the upstream Roo icon at [`src/assets/icons/icon.png`](./src/assets/icons/) so the build works out of the box. **Before publishing publicly you should ship your own icon** to avoid trademark confusion:

1. Save a 128×128 PNG as `src/assets/icons/icon-xroo.png` (any path under `src/assets/` works — `apps/vscode-xroo/esbuild.mjs` copies the entire `src/assets` directory into the VSIX).
2. Update `"icon"` in [`apps/vscode-xroo/package.xroo.json`](./apps/vscode-xroo/package.xroo.json) to `"assets/icons/icon-xroo.png"`.
3. Rebuild.

## 5. Build and run locally

Prerequisites (already pinned by the repo):

- Node `20.19.2` (see [`.nvmrc`](./.nvmrc))
- pnpm `10.8.1` (auto-bootstrapped by [`scripts/bootstrap.mjs`](./scripts/bootstrap.mjs) if missing)

```bash
# One-time install (downloads node_modules across the whole workspace).
pnpm install

# Build the XRoo bundle (compiles src/ + webview-ui in xroo mode, copies assets).
pnpm bundle:xroo

# Produce bin/xroo-<version>.vsix.
pnpm vsix:xroo

# Build + sideload into VS Code / Cursor / VS Code Insiders.
pnpm install:vsix:xroo
```

The installer script ([`scripts/install-vsix.js`](./scripts/install-vsix.js)) will prompt for which editor command to use (`code`, `cursor`, `code-insiders`). After install, **restart your editor** for the new extension to activate.

The output `.vsix` will be named `bin/<name>-<version>.vsix` where `<name>` and `<version>` come from [`apps/vscode-xroo/package.xroo.json`](./apps/vscode-xroo/package.xroo.json). With the defaults shipped today it is **`bin/xroo-0.1.0.vsix`**.

## 6. Publishing to the marketplaces

### One-time setup

1. **Create a VS Code Marketplace publisher** named `yuvalhuck`:
    - Sign in at <https://marketplace.visualstudio.com/manage> with the Microsoft / GitHub account you want to publish under.
    - Create a publisher with id **`yuvalhuck`** (must match `publisher` in `package.xroo.json`).
2. **Create an Azure DevOps Personal Access Token (PAT)** with **Marketplace → Manage** scope. Save it as a GitHub Actions secret named `VSCE_PAT` in your fork.
3. _(Optional but recommended)_ **Create an Open VSX account** at <https://open-vsx.org/> using the same `yuvalhuck` GitHub identity. Generate an access token and store it as `OVSX_PAT`. This makes XRoo installable in VSCodium, Cursor, code-server, etc.

### Publishing via GitHub Actions (recommended)

The workflow file [`.github/workflows/xroo-publish.yml`](./.github/workflows/xroo-publish.yml) is **manually triggered** (`workflow_dispatch`). To release:

1. Push your changes to the `yuvalhuck/XRoo` fork.
2. Go to **Actions → XRoo Publish → Run workflow**.
3. Optionally set:
    - `version` — overrides the value in `package.xroo.json` for this run (e.g. `0.1.1`).
    - `publish_vsce` (default: true) — push to VS Code Marketplace.
    - `publish_ovsx` (default: true) — push to Open VSX.
4. The workflow will:
    1. Patch the version (if provided).
    2. `pnpm vsix:xroo` → produces `bin/xroo-<version>.vsix`.
    3. Verify the VSIX contains all required runtime assets.
    4. Tag the commit as `xroo-v<version>` and push the tag.
    5. `vsce publish` and/or `ovsx publish` the VSIX.
    6. Create a GitHub Release with the VSIX attached.

### Publishing manually from your machine

```bash
pnpm vsix:xroo

# VS Code Marketplace
npx vsce login yuvalhuck
npx vsce publish --packagePath bin/xroo-0.1.0.vsix

# Open VSX
npx ovsx publish bin/xroo-0.1.0.vsix -p "$OVSX_PAT"
```

## 7. Things to do **before** the first public release

These are not blockers for building, but they are blockers for **publishing responsibly**:

- [ ] **Replace the icon** with your own — see §4. The current build reuses the Roo Code icon.
- [ ] **Rotate / remove telemetry keys.** The published-extension workflow [`.github/workflows/marketplace-publish.yml`](.github/workflows/marketplace-publish.yml) injects a `POSTHOG_API_KEY` secret into `.env`. The XRoo workflow does **not** do this, so by default no PostHog key is bundled. If you want telemetry for XRoo, add your own PostHog project key to your fork's `VSCE_PAT`-companion secrets and create a `.env` step similar to the upstream workflow — **do not reuse Roo's key**.
- [ ] **Audit cloud / billing endpoints.** Search the codebase for `roocode.com` and any `roo-cloud` references and decide whether to disable the calls or repoint them at your own backend. (At minimum, billing-only endpoints are inert without a Roo account, but they should not phone home from your fork.)
- [ ] **Update `CODEOWNERS`** ([`.github/CODEOWNERS`](./.github/CODEOWNERS)) — replace the upstream Roo maintainers with `@yuvalhuck` (and any collaborators).
- [ ] **Update `LICENSE`/NOTICE attribution.** XRoo inherits Apache 2.0 from upstream ([`LICENSE`](./LICENSE)) — keep the original copyright notice and add a one-line note that XRoo is a derivative work by yuvalhuck.
- [ ] **Trademark sweep.** "Roo", "Roo Code", and the Roo logo are not licensed for redistribution under a confusable name. Make sure your published listing makes it clear XRoo is an independent community build (e.g. add "Community fork of Roo Code — not affiliated with Roo Code, Inc." in `extension.description`).

## 8. Keeping up to date with upstream

The original design goal was for XRoo to never edit `src/` or `webview-ui/src/`,
so that syncing upstream was a vanilla `git merge upstream/main`. That goal is
intentionally relaxed for a small, well-scoped set of behavioral fixes —
listed in §10 below — that address bugs whose fix could not reasonably live in
a brand overlay. Each XRoo-owned edit is prefixed by a code comment beginning
with `XRoo:` so they are trivial to grep for during a merge:

```bash
git grep -nE "XRoo:" src webview-ui packages
```

Apart from that, the files you typically own and rarely change are inside
`apps/vscode-xroo/` plus the small `xroo` branches in `webview-ui/vite.config.ts`,
`webview-ui/package.json`, `webview-ui/turbo.json`, `package.json`, and
`scripts/install-vsix.js`. Conflicts there should be small and obvious.

## 9. Quick reference

| Task                              | Command                                            |
| --------------------------------- | -------------------------------------------------- |
| Build the XRoo bundle             | `pnpm bundle:xroo`                                 |
| Build the `.vsix`                 | `pnpm vsix:xroo`                                   |
| Build + sideload into your editor | `pnpm install:vsix:xroo`                           |
| Clean only the XRoo app outputs   | `pnpm --filter @roo-code/vscode-xroo clean`        |
| Clean everything                  | `pnpm clean`                                       |
| Publish                           | GitHub Actions → **XRoo Publish** (manual trigger) |

## 10. XRoo behavioral changes vs upstream Roo Code

These are the XRoo-specific behavior changes that live inside `src/` and
`webview-ui/src/`. They are all narrowly scoped and tagged with an `XRoo:`
comment so they survive `git merge upstream/main` as readable conflicts.

### 10.1 Auto-condense trigger math (fixes the "170% indicator, no cleanup" bug)

Upstream computed the auto-condense trigger as `contextTokens / contextWindow`,
which silently never crossed 100% because the UI shows `contextTokens /
(contextWindow − reservedTokens)`. A user-configured "trigger at 100%" therefore
never fired — long Claude / GPT tasks would sit at 90-150% (as shown in the
task header) and degrade silently until the API returned a context-window
error. The XRoo build:

- Uses **available input space** (`contextWindow − reservedTokens`) as the
  denominator, matching what the user sees in the task header
  ([`computeContextUsagePercent`](./src/core/context-management/index.ts)).
- Clamps any saved threshold to a hard **100% ceiling**
  (`ABSOLUTE_MAX_CONDENSE_THRESHOLD`) — "100% is the black line".
- Defaults a new install to **75%** instead of 100%
  (`DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT`) so condensing fires _before_
  the model's quality cliff (~80–90% of usable context).

### 10.2 Auto-condense retry with backoff

Upstream's `manageContext` did a single condense attempt and fell back to
sliding-window truncation on any failure, including transient ones (rate
limits, 5xx). XRoo wraps the call with
[`manageContextWithRetry`](./src/core/context-management/index.ts):

- Retries the condense **up to 3 times** with linear backoff (1s, 2s, 3s).
- Emits a new `condense_context_retry` say between attempts and on final
  give-up, rendered in the chat by
  [`CondensationRetryRow`](./webview-ui/src/components/chat/context-management/CondensationRetryRow.tsx).
- Skips the retry if `manageContext` already engaged the sliding-window safety
  net (so we never thrash when the user is already over the hard cap).

### 10.3 Always-visible "Clean Context" affordance

The upstream "intelligently condense context" button is buried behind the
TaskHeader expand chevron — a state most users never enter — so the recovery
action was effectively undiscoverable. XRoo surfaces a labeled
**"Clean Context"** button directly under the chat input
([`ChatTextArea`](./webview-ui/src/components/chat/ChatTextArea.tsx)). It is
disabled while a condense is already in flight or a send is mid-stream so it
can never double-trigger.

### 10.4 Sliding-window-active indicator

When auto-condense fails and the conversation is being trimmed by
sliding-window truncation, XRoo renders a yellow warning row directly above
the chat input cluster. Clicking it triggers the same handler as
**"Clean Context"** so the user has a one-click path back to a condensed,
high-quality context. The indicator auto-hides as soon as a successful
`condense_context` say arrives.

### 10.5 Tests

The matching tests live next to the production code:

- [`src/core/context-management/__tests__/context-management.spec.ts`](./src/core/context-management/__tests__/context-management.spec.ts) — new helper tests for `computeContextUsagePercent`, `resolveEffectiveCondenseThreshold`, `manageContextWithRetry`, and the FORK-XROO regression scenarios.
- [`webview-ui/src/components/chat/__tests__/ChatTextArea.xroo.spec.tsx`](./webview-ui/src/components/chat/__tests__/ChatTextArea.xroo.spec.tsx) — UI tests for the "Clean Context" button and the sliding-window indicator.
- [`webview-ui/src/components/chat/context-management/__tests__/CondensationRetryRow.spec.tsx`](./webview-ui/src/components/chat/context-management/__tests__/CondensationRetryRow.spec.tsx) — tests for all three payload shapes of `condense_context_retry`.
