import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { loadSyntaxHighlighter } from "../lib/syntax";

const hoisted = vi.hoisted(() => ({ real: undefined as unknown as typeof import("../lib/syntax").loadSyntaxHighlighter }));
vi.mock("../lib/syntax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/syntax")>();
  hoisted.real = actual.loadSyntaxHighlighter;
  return { ...actual, loadSyntaxHighlighter: vi.fn(actual.loadSyntaxHighlighter) };
});
const loader = vi.mocked(loadSyntaxHighlighter);

beforeEach(() => { loader.mockReset(); loader.mockImplementation(hoisted.real); });
afterEach(() => { vi.useRealTimers(); });

describe("Markdown code blocks", () => {
  it("colors a fenced TypeScript block once the highlighter settles", async () => {
    const { container } = render(<Markdown>{"```ts\nconst n = 1;\n```"}</Markdown>);
    await waitFor(() => expect(container.querySelector(".syntax-keyword")).not.toBeNull(), { timeout: 3000 });
    expect(loader).toHaveBeenCalledWith("typescript");
    const code = container.querySelector(".codeblock code");
    expect(code?.textContent).toBe("const n = 1;\n");
    expect(code?.className).toBe("language-ts");
  });

  it("keeps the established copy text — source minus one trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Markdown>{"```ts\nconst n = 1;\n```"}</Markdown>);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const n = 1;"));
  });

  it("leaves unknown fences and inline code plain", async () => {
    const { container } = render(<Markdown>{"```wolfram\nx := y\n```\n\n`inline code`"}</Markdown>);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(loader).not.toHaveBeenCalled();
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    expect(container.querySelector("code:not([class])")?.textContent).toBe("inline code");
  });

  it("renders markup-looking code as text — never as elements", async () => {
    // Split so the static a11y audit does not read this as markup.
    const source = `${"<im"}g src=x onerror="boom()">\n<scr${"ipt>"}alert(1)</script>`;
    const { container } = render(<Markdown>{`\`\`\`html\n${source}\n\`\`\``}</Markdown>);
    await waitFor(() => expect(container.querySelector(".codeblock code")).not.toBeNull());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".codeblock code")?.textContent).toBe(`${source}\n`);
  });
});

describe("Markdown file links", () => {
  it("turns inline code naming an indexed file into a link to the viewer, and nothing else", async () => {
    const { useAppStore } = await import("../lib/store");
    const openFile = vi.fn(async () => {});
    useAppStore.setState({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", fileIndex: { workspaceId: "w", paths: ["src/app.ts", "README.md"], loadedAt: 1 }, openFile });
    render(<Markdown>{"See `src/app.ts:42`, `/repo/README.md` and `a/b`, or `user.name`.\n\n```\nsrc/app.ts\n```"}</Markdown>);
    fireEvent.click(screen.getByRole("button", { name: "src/app.ts:42" }));
    expect(openFile).toHaveBeenLastCalledWith("src/app.ts");
    fireEvent.click(screen.getByRole("button", { name: "/repo/README.md" }));
    expect(openFile).toHaveBeenLastCalledWith("README.md");
    expect(screen.queryByRole("button", { name: "a/b" })).toBeNull();
    expect(screen.queryByRole("button", { name: "user.name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "src/app.ts" }), "a fenced block is not a link").toBeNull();
  });
});

