// agent/tools/types.ts - Shared tool types.
//
// Scaleway Generative APIs is OpenAI-compatible, so tool definitions use the
// OpenAI "function" tool shape (name/description/parameters as a JSON Schema
// object). loop.ts wraps each definition as { type: "function", function:
// definition } when it calls the API - see
// https://www.scaleway.com/en/docs/generative-apis/how-to/use-function-calling/.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<string | unknown>;

export interface ToolSpec {
  definition: ToolDefinition;
  handler: ToolHandler;
}
