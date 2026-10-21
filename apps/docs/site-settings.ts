/** Public origins only. Never put credentials into documentation builds. */
export function docsSettings(
  environment: Record<string, string | undefined> = process.env,
) {
  function origin(name: string, fallback: string) {
    const value = new URL(environment[name] || fallback);

    if (
      !["http:", "https:"].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash
    )
      throw new Error(
        `${name} must be an HTTP(S) origin without credentials, path, query or fragment.`,
      );

    return value.origin;
  }

  return {
    appUrl: origin("COUNTERSIGN_APP_URL", "http://localhost:8787"),
    docsUrl: origin("COUNTERSIGN_DOCS_URL", "http://localhost:4321"),
  };
}
