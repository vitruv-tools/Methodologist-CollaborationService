/** Describes an error for a log or error message, including the reason of a failed `fetch`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  // fetch reports network problems as "fetch failed" and puts the reason into `cause`.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
