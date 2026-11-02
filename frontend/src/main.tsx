import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { isApiError } from "./app/api";
import { keys } from "./app/queries";
import { createAppRouter } from "./app/router";
import { ToastProvider } from "./app/toast";
import "./app/app.css";

// An expired session on any request signs the browser out; RequireAuth then shows sign-in.
// (A wrong password at sign-in is INVALID_CREDENTIALS, not AUTH_REQUIRED.)
const signOutWhenSessionEnds = (error: unknown) => {
  if (isApiError(error, 401, "AUTH_REQUIRED")) client.setQueryData(keys.me, null);
};

const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signOutWhenSessionEnds }),
  mutationCache: new MutationCache({ onError: signOutWhenSessionEnds }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Only network and server trouble is worth retrying; a 4xx answer will not change.
      retry: (count, error) => count < 2 && (!isApiError(error) || error.status === 0 || error.status >= 500),
    },
  },
});

const router = createAppRouter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
