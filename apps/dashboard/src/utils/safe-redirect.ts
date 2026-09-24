/**
 * Resolves a caller-supplied redirect target to a same-origin relative path.
 *
 * Only a path rooted at "/" is accepted. Protocol-relative ("//host"),
 * backslash ("/\host") and absolute targets, and anything carrying control
 * characters or whitespace that a URL parser would strip, fall back instead,
 * so a redirect built from the result can never leave this origin.
 */
export const safeRedirectPath = (
  value: string | null | undefined,
  fallback = "/",
): string => {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    /[\u0000- \u007f\\]/.test(value)
  ) {
    return fallback;
  }

  // Belt and braces: resolve against a placeholder origin and require that the
  // origin did not change.
  const base = "https://same-origin.invalid";
  let resolved: URL;

  try {
    resolved = new URL(value, base);
  } catch {
    return fallback;
  }

  // Dot segments can collapse "/../..//host" into a protocol-relative path.
  if (resolved.origin !== base || resolved.pathname.startsWith("//")) {
    return fallback;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
};
