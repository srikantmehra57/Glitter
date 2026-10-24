import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProvidersPanel } from "./ProvidersPanel";

const opened = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../lib/bridge", async (original) => ({ ...(await original<typeof import("../lib/bridge")>()), openUrl: opened.openUrl }));

describe("providers panel", () => {
  it("saves an NVIDIA NIM key, links to where one is made, and shows only its mask", async () => {
    const changed = vi.fn();
    render(<ProvidersPanel onChanged={changed} />);
    const label = await screen.findByText("NVIDIA NIM");
    const row = label.closest(".provider-row") as HTMLElement;
    expect(within(row).getByText(/hosted by NVIDIA/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Add key" }));

    fireEvent.click(await within(row).findByRole("button", { name: /Get a key at build\.nvidia\.com/ }));
    expect(opened.openUrl).toHaveBeenCalledWith("https://build.nvidia.com/settings/api-keys");

    const field = within(row).getByLabelText("API key");
    expect(field).toHaveAttribute("placeholder", "nvapi-…");
    expect(field).toHaveAttribute("type", "password");
    expect(within(row).queryByLabelText("Address")).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "nvapi-secret-5678" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(await within(row).findByText("Connected")).toBeInTheDocument();
    expect(within(row).getByText("Key ••••5678")).toBeInTheDocument();
    expect(row.textContent).not.toContain("nvapi-secret");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("adds a named custom endpoint with its API type, then another beside it", async () => {
    const changed = vi.fn();
    render(<ProvidersPanel onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add a custom endpoint/ }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work gateway" } });
    fireEvent.change(screen.getByLabelText("API type"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://gateway.work.example/v1" } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: "gw-secret-9012" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    const first = await screen.findByText("Work gateway");
    const firstRow = first.closest(".provider-row") as HTMLElement;
    expect(within(firstRow).getByText("Connected")).toBeInTheDocument();
    expect(within(firstRow).getByText("Anthropic Messages · Key ••••9012 · https://gateway.work.example/v1")).toBeInTheDocument();

    // A second endpoint lands under its own name; the first is untouched.
    fireEvent.click(screen.getByRole("button", { name: /Add a custom endpoint/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "vLLM" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://localhost:8000/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    const second = await screen.findByText("vLLM");
    const secondRow = second.closest(".provider-row") as HTMLElement;
    expect(within(secondRow).getByText("OpenAI-compatible · Enabled · http://localhost:8000/v1")).toBeInTheDocument();
    expect(within(secondRow).queryByText(/••••9012/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(2);

    // Removing one removes only that one.
    fireEvent.click(within(secondRow).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("vLLM")).not.toBeInTheDocument());
    expect(screen.getByText("Work gateway")).toBeInTheDocument();
  });
});
