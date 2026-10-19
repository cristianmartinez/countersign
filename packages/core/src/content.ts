export interface EmailContent {
  from: string;
  to: [string];
  subject: string;
  text?: string;
  html?: string;
}

export function canonicalContent(content: EmailContent): string {
  return JSON.stringify({
    from: content.from,
    to: content.to,
    subject: content.subject,
    ...(content.text === undefined ? {} : { text: content.text }),
    ...(content.html === undefined ? {} : { html: content.html }),
  });
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
