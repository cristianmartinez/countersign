/** Resend's optional JSX renderer must stay outside the approved-string send path. */
export function render(): never {
  throw new Error(
    "Countersign sends approved HTML/text only. Render React Email before draft submission.",
  );
}
