import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
});
