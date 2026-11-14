import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../lib/types";
import { resetStore } from "../test/store";
import { ModelsProviders } from "./ModelsProviders";

const opened = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../lib/bridge", async (original) => ({ ...(await original<typeof import("../lib/bridge")>()), openUrl: opened.openUrl }));

const noop = vi.fn();

describe("models & providers panel", () => {
  beforeEach(() => {
    resetStore();
  });

  it("saves an NVIDIA NIM key, links to where one is made, and shows only its mask", async () => {
    render(<ModelsProviders draft={DEFAULT_SETTINGS} edit={noop} />);
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
  });

  it("adds a named custom endpoint with its API type, then another beside it", async () => {
    render(<ModelsProviders draft={DEFAULT_SETTINGS} edit={noop} />);
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

  it("shows an empty library with the add-model action, and disables it without a key", async () => {
    const { useAppStore } = await import("../lib/store");
    useAppStore.setState({ providerStatus: [] });
    render(<ModelsProviders draft={DEFAULT_SETTINGS} edit={noop} />);
    expect(await screen.findByText("No models yet")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add model" });
    // No provider is connected, so there is nothing to add a model from yet.
    expect(add).toBeDisabled();
  });

  it("opens the add-model dialog from a connected provider", async () => {
    const fetchProviderModels = vi.fn(async () => []);
    const { useAppStore } = await import("../lib/store");
    useAppStore.setState({ providerStatus: [{ id: "openai", configured: true, keyHint: "••••1234", baseUrl: null, name: null, wire: null }] });
    render(<ModelsProviders draft={DEFAULT_SETTINGS} edit={noop} />);
    const add = await screen.findByRole("button", { name: "Add model" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(screen.getByRole("heading", { name: "Add a model" })).toBeInTheDocument();
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });
});
