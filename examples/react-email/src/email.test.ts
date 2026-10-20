import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { renderDraft } from "./email";

describe("React Email authoring example", () => {
  it("renders both final bodies deterministically without networking", async () => {
    const a = await renderDraft(),
      b = await renderDraft();

    expect(a).toEqual(b);

    expect(a.to).toEqual(["delivered@resend.dev"]);

    expect(a.html.replace(/<!--[\s\S]*?-->/g, "")).toContain(
      "Thank you, reviewer.",
    );

    expect(a.text).toContain("A human must approve");

    expect(a.text).not.toContain("<html");

    expect(a.html).not.toMatch(/<script|<img|https?:\/\/(?!www\.w3\.org)/i);

    expect(
      JSON.parse(
        await readFile(new URL("../draft.json", import.meta.url), "utf8"),
      ),
    ).toEqual(a);
  });

  it("escapes authored values before producing the supplied strings", async () => {
    const value = await renderDraft({
      name: "<script>bad()</script>",
      message: "Personal & reviewed",
    });

    expect(value.html).toContain("&lt;script&gt;");

    expect(value.html).not.toContain("<script>bad()");

    expect(value.text).toContain("Personal & reviewed");
  });
});
