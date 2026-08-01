import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToasterProvider } from "./components/Toaster";
import { ShortcutsProvider } from "./hooks/useShortcuts";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ShortcutsProvider>
        <ToasterProvider>
          <RouterProvider router={router} />
          <div className="scanlines" />
        </ToasterProvider>
      </ShortcutsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
