# Deferred Tool Loading (Design Document)

## Problem

When many tools are registered (especially with MCP servers), sending all tool schemas in every API request wastes context tokens. With 20+ MCP tools, schemas can consume 10-15% of the context window.

## OpenClaude's Approach

OpenClaude implements a "ToolSearch" pattern using Anthropic's `tool_reference` API feature:

1. When tool definitions exceed ~10% of the context window, deferred mode activates
2. Deferred tools are sent as name-only references (`tool_reference` blocks) instead of full schemas
3. A `ToolSearchTool` lets the model search for and fetch full schemas on demand
4. The model sees tool names in a summary list and can `select:<tool_name>` to get the full definition

### Key Implementation Details
- Auto-threshold: activates when MCP tool tokens exceed a configurable percentage (default 10%)
- Model requirement: only works on models that support `tool_reference` content blocks (Sonnet 4+, Opus 4+)
- Discovery: deferred tools appear in a summary prompt section with name + one-line description
- Selection: `select:<tool_name>` fetches the full schema; keyword search scores by description similarity

## Pi's Current State

Pi does not currently support deferred tool loading because:
1. The `@mariozechner/pi-ai` package sends full `Tool[]` definitions to providers
2. No `tool_reference` equivalent exists in pi's tool representation
3. MCP tools are fully expanded at registration time

## Implementation Path

### Phase 1: Tool Summary in System Prompt (Low effort, immediate value)
Instead of API-level deferral, add a system prompt section listing all available tools by name + one-line description. This doesn't save API tokens but helps the model discover tools.

### Phase 2: Provider-level tool_reference Support
Add `tool_reference` support to `@mariozechner/pi-ai` for Anthropic provider:
- Extend `Tool` type to support `deferred: true` flag
- Anthropic provider sends deferred tools as `tool_reference` blocks
- Other providers fall back to full schemas (or skip deferred tools)

### Phase 3: ToolSearch Tool
Implement a `tool_search` tool that:
- Accepts a query string
- Returns matching tool schemas from the deferred set
- Auto-enables when tool token count exceeds threshold

### Threshold Calculation
```typescript
// Rough token estimation: JSON schema chars / 4
function estimateToolTokens(tools: Tool[]): number {
  return tools.reduce((sum, t) => {
    const schemaSize = JSON.stringify(t.parameters ?? {}).length;
    return sum + Math.ceil(schemaSize / 4) + 50; // 50 token overhead per tool
  }, 0);
}
```

## Decision

Phase 1 is not needed (pi already lists tools in the system prompt via `promptSnippet`).
Phase 2-3 requires changes to `@mariozechner/pi-ai` and is tracked separately.
