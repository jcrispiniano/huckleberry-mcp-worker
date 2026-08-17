/**
 * Tool results travel as a single JSON text block, matching what the Python
 * server returned once FastMCP serialised its dict/list return values.
 */
export function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}
