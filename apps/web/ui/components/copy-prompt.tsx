/** @jsxImportSource react */
import { useState } from "react";
import { Button } from "../../src/components/ui/button";

export function CopyPrompt({
  copyPrompt,
}: {
  copyPrompt?: () => Promise<string>;
}) {
  const [status, setStatus] = useState("");

  async function copy() {
    if (copyPrompt) setStatus(await copyPrompt());
  }

  return (
    <>
      <Button id="copy-prompt" type="button" onClick={copy}>
        Copy setup prompt
      </Button>
      <p id="copy-status" role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}
