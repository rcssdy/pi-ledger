/** Collapse whitespace and trim text intended for a one-line journal field. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Truncate by Unicode code points, reserving the final code point for an ellipsis. */
export function truncateCodePoints(text: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("The code-point limit must be a positive safe integer");
  }
  const codePoints = [...text];
  if (codePoints.length <= limit) return text;
  return `${codePoints.slice(0, limit - 1).join("")}…`;
}
