/** @jsxImportSource react */
import { useMemo, useRef, useState, type FormEvent } from "react";
import { EmailEditor, type EmailEditorRef } from "@react-email/editor";
import "@react-email/editor/themes/default.css";
import { Input } from "../../src/components/ui/input";
import { Label } from "../../src/components/ui/label";
import { Button } from "../../src/components/ui/button";
import type { ReviewEditorProps } from "./review-detail";

export default function ReviewEditor({
  current,
  preview,
  action,
  csrf,
  onCancel,
}: ReviewEditorProps) {
  const editor = useRef<EmailEditorRef>(null);
  const changed = useRef(false);
  const [subject, setSubject] = useState(current.subject);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mutationKey] = useState(() => crypto.randomUUID());

  // Only display-sanitized HTML enters the editor. Never load remote images or links.
  const content = useMemo(() => {
    if (!preview) {
      return (current.text_body ?? "")
        .split("\n")
        .map((line) => {
          const p = document.createElement("p");
          p.textContent = line;
          return p.outerHTML;
        })
        .join("");
    }

    const parsedDocument = new DOMParser().parseFromString(
      preview,
      "text/html",
    );
    for (const element of parsedDocument.querySelectorAll<HTMLElement>(
      "[style]",
    )) {
      if (element.style.display === "none") element.remove();
    }

    // Email layout tables are presentation scaffolding, not editable data tables.
    // Start a semantic document; only an explicit body edit exports this layout.
    for (const element of parsedDocument.body.querySelectorAll(
      "table,thead,tbody,tfoot,tr,td,th,div,span,section,article,header,footer,main,center",
    )) {
      element.replaceWith(...element.childNodes);
    }

    for (const element of parsedDocument.body.querySelectorAll("[style]")) {
      element.removeAttribute("style");
    }

    return parsedDocument.body.innerHTML;
  }, [preview, current.text_body]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const bodies = changed.current
        ? await editor.current!.getEmail()
        : { html: current.html_body, text: current.text_body };
      const form = new URLSearchParams({
        csrf,
        base_revision_id: current.id,
        mutation_key: mutationKey,
        subject,
      });

      if (bodies.html !== null) form.set("html", bodies.html);
      if (bodies.text !== null) form.set("text", bodies.text);

      const response = await fetch(action, {
        method: "POST",
        body: form,
        credentials: "same-origin",
        headers: { "X-Requested-With": "Countersign" },
      });

      if (!response.ok) {
        setError(
          response.status === 409
            ? "This email changed or was approved. Reload before editing again."
            : response.status === 422 || response.status === 413
              ? "Use a subject of 1–200 characters and bodies under 100 KiB each."
              : "Could not save this revision. Your changes are still here; try again.",
        );
        setSaving(false);
        return;
      }

      window.location.assign(response.url);
    } catch {
      setError(
        "Could not save this revision. Your changes are still here; try again.",
      );
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="m-0 space-y-4" aria-label="Edit email">
      <div className="space-y-2">
        <Label htmlFor="edit-subject">Subject</Label>
        <Input
          id="edit-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          required
          disabled={saving}
        />
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        Visual editing rebuilds the email layout. Saving creates a new revision
        with HTML and plain text for review.
      </p>
      <div className="email-editor h-80 overflow-auto rounded-lg border bg-white p-4 text-black">
        <EmailEditor
          ref={editor}
          content={content}
          onReady={() => setReady(true)}
          onUpdate={() => {
            changed.current = true;
          }}
          editable={!saving}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !ready}>
          {saving ? "Saving…" : "Save revision"}
        </Button>
      </div>
    </form>
  );
}
