# design-canvas

![CI](https://github.com/xr192172/design-canvas/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)
![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)

> Give your codebase a **living document** and a **quality gate**. As a standard MCP server, design-canvas encodes design and contracts into structured DSL JSON — auto-backfilled as code evolves, never stale — and turns LLM code changes into a controlled pipeline of **precise editing, runtime verification, and rollback on failure**.

[中文](README.md) · [English](README.en.md)

![design-canvas companion frontend dsl-workbench sandbox view (real-time DSL rendering)](assets/demo-workbench.png)

## Background & Positioning

Two chronic problems in engineering collaboration, both addressed by design-canvas:

**Problem 1: Documentation drift.** Every design doc and architecture diagram goes stale as code evolves, until nobody trusts it. design-canvas encodes the "design truth" as **structured DSL JSON** that evolves with the code: the semantic layer records file contracts (files / apis / decisions), auto-backfilled from the implementation by `backfill_scaffold` and corrected by runtime observation (Observe) — **documentation no longer goes stale**.

**Problem 2: Uncontrolled changes.** LLMs often edit the wrong location, break files, and produce changes that can't be verified — forcing rework. design-canvas provides a controlled change pipeline: symbol-level precise editing (`edit_code`) → real diff review before applying → runtime probe reconciliation → commit only on pass, auto-rollback on failure — **changes no longer rely on luck**.

The two-layer DSL is the common foundation:

* **`geometry`**: node positions and edges — what it looks like;
* **`semantic`**: node meaning, contracts, and decisions — why it was done this way.

Human–LLM collaboration is the carrier of this mechanism, not the whole story: both share the same DSL JSON, and a frontend renders it into interactive diagrams for review, annotation, and modification.

The project follows a **frontend/backend separation** architecture:

| Layer | Responsibility | Carrier |
|---|---|---|
| **Data / protocol layer** | DSL storage, code understanding, generation/backfill/consistency, brick system, runtime verification, diagnosis loop; exposes MCP tools and an HTTP API | This repository (MCP server) |
| **Visual collaboration frontend** | Renders live DSL into an interactive workbench (sandbox, version diff, issue list, probes, contracts, code approval) | [dsl-workbench](https://github.com/xr192172/dsl-workbench) (separate repo) |
| **Built-in renderer** | Fallback preview when no frontend is available; renders a single DSL into a self-contained HTML file | `render_design` (built-in) |

## Core Capabilities

One thread runs through everything: **any code → bricks (production) → trusted assembly (quality control)**. The **contract** is the single shared interface between the two ends — the brick line produces contracts, the verification line validates them.

| Capability | Description | Representative tools |
|---|---|---|
| **Visual protocol layer** | DSL read/write/edit, design view vs. actual code snapshot diff, built-in render fallback | `get_dsl` / `edit_dsl` / `manage_feature` / `render_design` / `diff_views` |
| **Code understanding** | Project import, semantic search, impact analysis, architecture layering, monolith splitting, algorithm/dataflow derivation | `import_project` / `explore_code` |
| **Brick system** | Harvest code from any source (URL / local project) into contract-bearing bricks: extraction, slimming, search, and assembly | `harvest_from_url` / `harvest_closure` / `extract_contracts` / `slim_brick` / `search_bricks` / `assemble_bricks` |
| **Runtime verification** | Reconcile contracts and behavior baselines against actual runtime observations, forming a "commit only if verified, roll back on failure" gate | `observe_instrument` / `observe_judge` / `reconcile_chain` / `reconcile_brick` / `reconcile_effects` |
| **Generation / backfill / consistency** | Generate code skeleton from DSL, backfill contracts from implementation, output consistency reports | `scaffold` / `backfill_scaffold` / `consistency_check` |
| **Deterministic refactoring (no rework)** | Symbol-level editing (never matches wrong), bulk/cross-file renaming, dead code removal, diff review before applying, rollback on failure | `edit_code` / `rename_*` / `refactor_pipeline` |
| **Diagnosis loop** | Full chain from symptom → root cause → fix → verify → commit (or roll back) | `diagnose` / `refactor_judge` / `diagnose-loop` (CLI) |
| **Multi-language AST foundation** | Unified extraction of symbols / imports / call edges / type references on top of tree-sitter | `ts_kernel` / `package_migration` |

## Quick Start

```bash
# 1. Clone the repository to your machine (first time)
git clone https://github.com/xr192172/design-canvas.git
cd design-canvas

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Start the MCP server (stdio mode)
npm start
```

Register in your MCP client configuration:

```json
{
  "mcpServers": {
    "design-canvas": {
      "command": "node",
      "args": ["/path/to/design-canvas/dist/src/server.js"]
    }
  }
}
```

You can also install into all major MCP clients (Claude / Cursor / VS Code / Codex / Copilot / Gemini / Windsurf / Cline) with one command:

```bash
node scripts/install_mcp.mjs            # Write config into all installed clients (auto-merge + backup)
node scripts/install_mcp.mjs --list     # Show config paths and write status per platform
node scripts/install_mcp.mjs --dry-run  # Preview what will be written (no disk writes)
node scripts/install_mcp.mjs --target claude  # Write a single platform only
```

### One-command demo (golden path)

Want to see what it looks like before wiring it up? One command builds, seeds the built-in example, starts the server, and opens the workbench:

```bash
npm run demo                # Full demo: render example → start server → open /workbench
npm run demo -- 8081        # Custom port
npm run demo -- --prepare   # Prepare only (build + render + register), no server
```

Your browser opens `http://localhost:3000/workbench`: the left canvas is an interactive diagram rendered from the example DSL (click nodes for details, conditional-branch animation flows), with sandbox feedback and code approval on the right. Existing features with the same name are skipped, so your data is never overwritten.

> The full visual collaboration frontend lives in [dsl-workbench](https://github.com/xr192172/dsl-workbench). Without a frontend environment, the built-in renderer (`render_design`) renders a single DSL into a self-contained HTML preview.

## MCP Tool Reference

A total of **50 MCP tools** are registered, organized into "capability navigation + primary tools + specialized tools": `capability_map` provides layered capability-lane navigation, primary tools provide unified entry points, specialized tools each do one job.

### Capability navigation (1)

| Tool | Purpose |
|------|------|
| `capability_map` | Capability-lane navigation: 6 lanes (design / refactor / observe / harvest / cross / meta) × in-lane tools with when-to-use; the agent layers then enters a concrete tool. High-frequency tools can bypass this navigation |

**Usage examples**

```json
// 1. No args: return the map of all 6 capability lanes (recommended: locate first)
{}

// 2. View a single lane (e.g. the refactor/rename lane)
{ "lane": "refactor" }

// 3. Valid lane values
{ "lane": "design" }    // design / living docs
{ "lane": "refactor" }  // refactor / rename
{ "lane": "observe" }   // observe / verify
{ "lane": "harvest" }   // contract / closure harvesting
{ "lane": "cross" }     // cross-repo / hybrid / health
{ "lane": "meta" }      // meta-info / exploration
```

> Note: `capability_map` is a read-only navigation with no side effects. The return is a three-level map "lane → in-lane tools → when to use each"; the agent picks a tool from it, then enters the concrete tool. High-frequency tools (`get_dsl` / `edit_dsl` / `explore_code` / `rename_symbols` / `rename_files` / `find_references`) work directly without going through it first.

### Primary tools (8)

| Tool | Purpose |
|------|------|
| `get_dsl` | Unified read-only entry: query DSL / nodes / edges / files / decisions / annotations / snapshots / simulation state / diffs, with `view` (design/live) and filter parameters |
| `edit_dsl` | Unified write entry: batch `operations[]` for add/update/delete, semantic binding, status updates, annotations, approvals, auto-layout; executed in order, full rollback on any failure (atomic) |
| `manage_feature` | Feature lifecycle management: create / clone / template / list / delete |
| `render_design` | Render entry: mindmap / html / svg / markdown, with `view` and output path |
| `scaffold` | Generate a code skeleton from the DSL semantic layer (vue / react / html) + status inference |
| `backfill_scaffold` | Parse implementation API signatures back into actual_apis and output a diff report |
| `consistency_check` | Compare expected contracts against actual code; output a consistency report and cross-file invariants (read-only) |
| `explore_code` | Code understanding entry: semantic search, impact analysis, architecture layering, monolith detection, split suggestions, algorithm/dataflow derivation, simulation replay, etc. |

### Specialized tools (41)

**Code understanding**

| Tool | Purpose |
|------|------|
| `import_project` | Import a code project into DSL (local absolute path or browser upload; honors `.gitignore`) |
| `diff_views` | Diff the design view against the live code snapshot |
| `render_brickwork` | Render a dependency-driven feature-community workbench (brickified preview) |
| `find_references` | Query symbol / field references (reference view: see blast radius before changing); read-only |
| `detect_drift` | Check whether the design is stale / under-implemented against the code change |

**Brick system**

| Tool | Purpose |
|------|------|
| `harvest_closure` | Harvest bricks together with their transitive import closure |
| `harvest_from_url` | Harvest bricks from a git URL / local project into the brick bag |
| `harvest_decisions` | Reverse-extract design decisions from project records |
| `extract_contracts` | Extract brick contracts (role / shapes / effects) |
| `reconcile_effects` | Reconcile effect candidates against runtime observations |
| `reconcile_brick` | Reconcile brick contracts against runtime observations |
| `search_bricks` | Search the brick shelf (cross-project reuse directory) |
| `assemble_bricks` | Assemble a new project from boxed bricks |
| `slim_brick` | Slim a Go brick into a derived brick (compiler-style dead code elimination) |
| `narrate_step` | Narrate a pipeline step as a governed narration brick |

**Runtime verification (Observe)**

| Tool | Purpose |
|------|------|
| `observe_instrument` | Auto-instrument / restore TS projects; writes a probe ledger and stats after the run |
| `observe_log` | Query runtime logs per file |
| `observe_judge` | Batch-judge runtime events |
| `reconcile_chain` | Reconcile a host chain against its real runtime events |
| `run_tests` | Run tests and return structured failure localization (filter-targeted / full) |

**Deterministic refactoring**

| Tool | Purpose |
|------|------|
| `edit_code` | Symbol-level code editing (replace / insert / delete / range) |
| `rename_many` | Bulk-rename local variables (scope-isolated) |
| `rename_symbols` | Batch cross-file symbol renaming (single or batch unified entry; whole-run dry-run first) |
| `rename_files` | Batch file renaming (single or batch unified entry; whole-run dry-run first) |
| `remove_dead_imports` | Remove stale imports |
| `refactor_pipeline` | Deterministic refactoring pipeline (dead code cleanup + package migration) |
| `suggest_renames` | Suggest semantic names for short / meaningless variables |
| `find_similar_names` | Detect and disambiguate easily-confused similar names |

**Diagnosis & review**

| Tool | Purpose |
|------|------|
| `refactor_judge` | LLM review gate: accept / reject / escalate uncertain items |
| `diagnose` | Symptom → root cause analysis: locate candidates → trace call chain → assess impact → aggregate root cause → suggest verification |

**Canvas annotations**

| Tool | Purpose |
|------|------|
| `canvas_notes` | Unified canvas-notes entry (read=work orders / mark=status / decide=LLM) |
| `archive_node` | Archive DSL nodes (snapshot) |
| `list_archive` | List archived nodes |
| `sync_contracts` | Backfill DSL contracts using the server_registry schema as source |

**LLM gateway**

| Tool | Purpose |
|------|------|
| `gateway_provider` | Unified LLM gateway entry (list / upsert / delete / stats) |

**Project docs**

| Tool | Purpose |
|------|------|
| `read_project_docs` | Read the doc list and content under a project's `docs/` directory |

**Migration & assessment**

| Tool | Purpose |
|------|------|
| `impact_analysis` | Pre-change risk-closure report: change points → reverse reachable closure, output affected files and risk ranking (`hubs=true` for hot-spot survey) |
| `cross_repo_symbol_index` | Cross-project symbol index: intersection of top-level symbols = conflicts / twins, difference = migration scope |
| `hybrid_precheck` | Project hybrid precheck: symbol conflicts + dependency version conflicts + feature overlap → verdict ok / fix / blocked |
| `behavior_baseline` | Behavior baseline: canary harness runs sample cases and records a snapshot, verify after changes to confirm "does it work" |
| `code_health` | Code health score: dead code / cyclomatic complexity / layering violations → health score + issue list |

### The `view` parameter

- `design` (default): the design view — live DSL + feature archive, the object the LLM actively designs and iterates on; corresponds to the "Design" view in the browser;
- `live`: the actual view — a read-only code snapshot rebuilt by `import_project` / `explore_code`; corresponds to the "Actual" view in the browser.

The design view is what gets iterated; the actual view is what the code currently looks like. `diff_views` compares the two.

## Capability Matrix & Multi-language Support

Tools are built on a **168+ language AST parser** (tree-sitter) loaded on demand. The core foundation `ts_kernel` fully supports every installed language (symbols / imports / call edges / type references); some refactoring features are rolled out per language tier:

- **full_ast**: Go / TypeScript / JS family in full; Python depending on the feature
- **regex_fallback**: a few features fall back to regex for some languages
- **unimplemented**: unimplemented "feature × language" pairs — explicitly registered, visible, and schedulable

Scan gaps automatically during a health check:

```bash
npm run doctor        # Environment readiness check + capability matrix gap self-check
npm run capability    # Output capability gaps (JSON / human-readable)
```

## Diagnosis Loop (CLI)

`diagnose-loop` upgrades diagnosis from "just suggestions" to "closed-loop execution": diagnose → fix → verify → commit (or roll back).

```bash
npm run diagnose-loop -- --project <project-dir> --symptom "<symptom>"
```

| Flag | Description |
|---|---|
| `--project <dir>` | Target project (must be a git repository; rollback relies on git) |
| `--symptom "<symptom>"` | Symptom description (error message / observed behavior) |
| `--auto` | Fully automatic: baseline commit + skip patch approval + auto-commit on pass |
| `--apply` | Apply the patch directly, skipping approval (the real diff is still printed for review) |
| `--skip-verify` | Skip the verification phase |
| `--verify-timeout <sec>` | Verification command timeout (default 300s) |

Flow: baseline snapshot (auto-commit before changes) → build symbol cache → diagnose (rule + LLM dual engine) → LLM line-level patch (modification whitelist + line-range validation + approval showing the real diff) → run the project's tests: on pass, commit exactly the patched files; on failure, roll back automatically.

## Testing & Verification

```bash
npm test              # Full vitest suite
npm run doctor        # Environment health check + capability gaps
```

## Tech Stack

- **MCP server**: TypeScript + [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- **AST parsing**: tree-sitter (Go / TypeScript / Python / JavaScript), language packs detected at runtime
- **Renderer**: HTML string assembly (zero build chain, self-contained single-file output)
- **Schema validation**: ajv + ajv-formats
- **Testing**: vitest

## Agent Guidance

The repository ships agent-facing skills (`.trae/skills/`):

- **design-canvas-router**: progressive-disclosure routing — "what problem → which tool", layer by layer; check existing capabilities first before deciding to build a new tool;
- **design-canvas-mind**: a mental wrapper providing a capability map, needs-to-toolchain orchestration, tool-call caching, and honest-delivery discipline.

Loading these two skills before using the toolchain is recommended, to avoid reinventing the wheel.

## License

MIT
