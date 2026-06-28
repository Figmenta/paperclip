// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIG-1673: the approval page must disclose the credential class so an operator
// never approves a non-expiring SERVICE key thinking it is an expiring human key.

const mockAccessApi = vi.hoisted(() => ({
  getCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useParams: () => ({ id: "challenge-1" }),
  useSearchParams: () => [new URLSearchParams("token=secret-token-secret-token")],
}));

import { CliAuthPage } from "./CliAuth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function baseChallenge(keyClass: "human_cli" | "service") {
  return {
    id: "challenge-1",
    status: "pending" as const,
    command: "paperclip-task-dispatch",
    clientName: "ivan-cowork",
    requestedAccess: "board" as const,
    keyClass,
    requestedCompanyId: null,
    requestedCompanyName: null,
    approvedAt: null,
    cancelledAt: null,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    approvedByUser: null,
    requiresSignIn: false,
    canApprove: true,
    currentUserId: "user-1",
  };
}

describe("CliAuthPage credential-class disclosure (FIG-1673)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CliAuthPage />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("warns that a service-class approval mints a non-expiring credential", async () => {
    mockAccessApi.getCliAuthChallenge.mockResolvedValue(baseChallenge("service"));
    const root = await renderPage();

    const text = container.textContent ?? "";
    expect(text).toContain("Service — never expires");
    expect(text).toContain("Non-expiring service credential");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("does not show the non-expiring warning for a human_cli key", async () => {
    mockAccessApi.getCliAuthChallenge.mockResolvedValue(baseChallenge("human_cli"));
    const root = await renderPage();

    const text = container.textContent ?? "";
    expect(text).toContain("Human CLI");
    expect(text).not.toContain("Non-expiring service credential");

    await act(async () => root.unmount());
  });
});
