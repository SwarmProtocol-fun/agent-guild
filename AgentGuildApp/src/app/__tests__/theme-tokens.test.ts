/** Guards the structural pieces of globals.css that light mode depends on. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "globals.css"), "utf8");

describe("globals.css theme tokens", () => {
  it("exposes the shadcn tokens to Tailwind via @theme inline", () => {
    const block = css.match(/@theme inline \{([\s\S]*?)\}/)?.[1] ?? "";
    for (const name of ["background", "foreground", "card", "muted", "muted-foreground", "border", "primary", "primary-foreground", "accent"]) {
      expect(block).toContain(`--color-${name}: hsl(var(--${name}));`);
    }
  });

  it("keeps the default border color in @layer base so border-* utilities win", () => {
    expect(css).toMatch(/@layer base \{\s*\*, ::before, ::after \{\s*border-color: hsl\(var\(--border\)\);/);
    // An unlayered `* { border-color }` would override every Tailwind border utility.
    expect(css).not.toMatch(/^\* \{[^}]*border-color/m);
  });

  it("uses white text on the violet primary in both themes", () => {
    const root = css.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const dark = css.match(/\n\.dark \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(root).toContain("--primary-foreground: 0 0% 100%;");
    expect(dark).toContain("--primary-foreground: 0 0% 100%;");
  });
});
