/**
 * SDK-neutral tool types for the Ask-AI chat.
 *
 * Tool definitions live in plain JSON-Schema-ish shape (the same
 * shape Anthropic's `input_schema` uses); the Gemini boundary
 * converts to `parametersJsonSchema` at call time. Keeping the
 * definitions neutral means a future provider swap (or running A/B
 * tests across providers) doesn't ripple through every tool.
 *
 * If we ever migrate to Vercel AI SDK's unified tool layer, this
 * file becomes the natural seam: the converter functions move to
 * the SDK adapter and the rest of the codebase stays put.
 */

import type { FunctionDeclaration } from '@google/genai'

export interface ToolDefinition {
  name: string
  description: string
  /**
   * JSON Schema describing the tool's input. Use lowercase type
   * strings (`'object'`, `'string'`, `'array'`, ...) — Gemini's
   * `parametersJsonSchema` accepts raw JSON Schema, so no enum
   * conversion is needed.
   */
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolCtx {
  userId: string
}

export interface ChatTool {
  definition: ToolDefinition
  handler: (input: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>
}

/**
 * Translate a neutral `ToolDefinition` into the shape Gemini's
 * `generateContent` expects under `config.tools[0].functionDeclarations`.
 *
 * We use `parametersJsonSchema` (not `parameters`) so the lowercase
 * JSON Schema we author flows through verbatim. `parameters` would
 * require the uppercase `Type.OBJECT` enum-style schema, which would
 * mean rewriting every tool definition — a lot of churn for zero
 * runtime difference.
 */
export function toGeminiFunctionDeclaration(
  def: ToolDefinition,
): FunctionDeclaration {
  return {
    name: def.name,
    description: def.description,
    parametersJsonSchema: def.input_schema,
  }
}
