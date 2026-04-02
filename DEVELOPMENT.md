# Local Development Setup

This is a local fork of [pi-mono](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) for development.

## Repository Structure

```
pi-mono/
├── packages/
│   ├── coding-agent/   # @mariozechner/pi-coding-agent (the `pi` CLI)
│   ├── tui/            # @mariozechner/pi-tui (terminal UI components)
│   ├── ai/             # @mariozechner/pi-ai (LLM provider abstraction)
│   ├── agent/          # @mariozechner/pi-agent-core (agent loop)
│   ├── mom/            # @mariozechner/pi-mom (mother-of-models)
│   ├── web-ui/         # @mariozechner/pi-web-ui
│   └── pods/           # @mariozechner/pi (pods)
└── ...
```

## Prerequisites

- Node.js >= 22
- npm with `--include=dev` (this system has `npm config set omit=dev` globally, so always pass `--include=dev`)

## Initial Setup

```bash
cd /home/ponet/Software/pi-mono

# Install dependencies (--include=dev is required because npm omit=dev is set globally)
npm install --include=dev --ignore-scripts

# Pin the exact tsgo version used by the project
npm install --include=dev --ignore-scripts @typescript/native-preview@7.0.0-dev.20260120.1

# Build all packages (sequential: tui → ai → agent → coding-agent → mom → web-ui → pods)
npm run build

# Run tests (coding-agent only — fastest feedback loop)
cd packages/coding-agent && npm test

# Run all tests
cd /home/ponet/Software/pi-mono && npm test
```

## Git Remotes

| Remote   | URL                                         | Purpose       |
|----------|---------------------------------------------|---------------|
| `origin` | `git@github.com:badlogic/pi-mono.git`       | Upstream      |
| `fork`   | `git@github.com:louisponet/pi-mono.git`     | Personal fork |

```bash
# Sync with upstream
git fetch origin && git merge origin/main

# Push to fork
git push fork <branch>
```

## Wiring to Nest

Nest spawns `pi` as a child process via the Bridge (see `nest/src/bridge.ts`).
The command is configurable per session via `config.yaml`.

### Option 1: Config-based (recommended for quick testing)

Edit `/home/ponet/Software/nest/config.yaml`:

```yaml
sessions:
    default:
        pi:
            cwd: /home/ponet
            command: /home/ponet/Software/pi-mono/packages/coding-agent/dist/cli.js
```

This makes all sessions spawn the local pi binary instead of the npm-installed one.
**Requires a Nest restart** to take effect.

### Option 2: Symlink replacement (applies globally without config change)

Replace the npm-installed package with a symlink to the local build:

```bash
# Back up the original
mv /home/ponet/Software/nest/node_modules/@mariozechner/pi-coding-agent \
   /home/ponet/Software/nest/node_modules/@mariozechner/pi-coding-agent.bak

# Symlink to local build
ln -s /home/ponet/Software/pi-mono/packages/coding-agent \
   /home/ponet/Software/nest/node_modules/@mariozechner/pi-coding-agent
```

This also wires up `@mariozechner/pi-coding-agent` as a Node module import (used by pi-ptc).

To also link pi-tui (imported by Nest for TUI rendering):

```bash
mv /home/ponet/Software/nest/node_modules/@mariozechner/pi-tui \
   /home/ponet/Software/nest/node_modules/@mariozechner/pi-tui.bak

ln -s /home/ponet/Software/pi-mono/packages/tui \
   /home/ponet/Software/nest/node_modules/@mariozechner/pi-tui
```

### Option 3: Global binary override

Replace the system-wide pi binary:

```bash
# Current global: /usr/bin/pi -> /usr/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js
# To switch (requires sudo):
sudo npm link   # from packages/coding-agent/
```

### Verifying the switch

```bash
# Check which pi binary resolves
which pi
# Should show the expected path

# Check version
pi --version
# Should show 0.60.0 (or your modified version)

# Quick RPC test (how Nest uses pi)
echo '{"jsonrpc":"2.0","method":"ping","id":1}' | pi --mode rpc
```

## Development Workflow

```bash
# 1. Make changes in packages/coding-agent/src/ (or other packages)
# 2. Rebuild
npm run build
# Or for faster iteration, rebuild just the changed package:
cd packages/coding-agent && npm run build

# 3. Run tests
cd packages/coding-agent && npm test

# 4. Nest picks up changes on next session start (no Nest restart needed
#    if using Option 1 — new sessions will use the rebuilt binary)
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/coding-agent/src/cli.ts` | CLI entry point |
| `packages/coding-agent/src/modes/rpc/` | RPC mode (used by Nest) |
| `packages/coding-agent/src/core/` | Core agent logic |
| `packages/agent/src/agent-loop.ts` | Agent loop (message processing) |
| `packages/ai/src/` | LLM provider implementations |
| `packages/tui/src/` | TUI component library |

## Notes

- The `npm config set omit=dev` is set globally on this system. Always use `--include=dev` for development installs.
- `tsgo` (TypeScript native compiler) is used for builds. Pin to `7.0.0-dev.20260120.1` — newer versions may have stricter checks.
- The `husky` prepare script will fail (no git hooks needed for dev). Use `--ignore-scripts` during install.
- Nest references `@mariozechner/pi-tui` directly (v0.57.1 in its package.json) for TUI rendering. If you modify pi-tui, use the symlink approach (Option 2) to test changes in Nest.
