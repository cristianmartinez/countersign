/** @jsxImportSource react */
export function AppHeader({
  review = false,
  docsUrl = "/docs",
}: {
  review?: boolean;
  docsUrl?: string;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">
          c.
        </span>
        Countersign
      </a>
      {review ? (
        <nav aria-label="Main navigation">
          <a href="/review">Emails</a>
          <a href="/connect">Connect your agent</a>
          <a href={docsUrl}>Agent documentation</a>
        </nav>
      ) : (
        <a
          className="text-sm text-muted-foreground hover:text-foreground"
          href={docsUrl}
        >
          Agent documentation
        </a>
      )}
    </header>
  );
}
