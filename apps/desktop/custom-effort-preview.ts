import React from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./src/components/Composer";
import { useAppStore } from "./src/lib/store";
import "./src/styles.css";

// The catalog fixture initializes first; the composer reads that store on mount.
const mount = () => {
  const state = useAppStore.getState();
  if (!state.models.some((model) => model.modelId === "custom-1/moonshotai/kimi-k3.1-pro")) {
    requestAnimationFrame(mount);
    return;
  }
  createRoot(document.getElementById("root")!).render(React.createElement("main", { className: "main" }, React.createElement("section", { className: "thread-column" }, React.createElement("div", { style: { flex: 1 } }), React.createElement(Composer))));
};
mount();
