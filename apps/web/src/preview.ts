const ALLOWED_TAGS = new Set([
  "div",
  "p",
  "span",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "a",
  "img",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "center",
]);

const DISCARD_CONTENT = new Set([
  "title",
  "script",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "noscript",
  "textarea",
  "style",
]);

const ATTRIBUTES = new Set([
  "style",
  "title",
  "lang",
  "dir",
  "alt",
  "width",
  "height",
  "colspan",
  "rowspan",
  "align",
  "valign",
]);

/** Display-only restrictions. The sandbox/CSP are required independent browser barriers. */
export async function previewDocument(source: string): Promise<string> {
  const safe = await new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();

        if (DISCARD_CONTENT.has(tag)) {
          element.remove();

          return;
        }

        if (!ALLOWED_TAGS.has(tag)) {
          element.removeAndKeepContent();

          return;
        }

        for (const [name, value] of [...element.attributes]) {
          if (!name) continue;

          if (
            !ATTRIBUTES.has(name.toLowerCase()) ||
            (name.toLowerCase() === "style" &&
              (/url|image|@/i.test(value ?? "") ||
                (value ?? "").includes("\\") ||
                (value ?? "").includes("/*")))
          )
            element.removeAttribute(name);
        }
      },
    })
    .transform(new Response(source))
    .text();

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"></head><body>${safe}</body></html>`;
}
