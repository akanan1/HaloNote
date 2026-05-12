import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";

const requestPasswordResetMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  requestPasswordReset: (...args: unknown[]) =>
    requestPasswordResetMock(...args),
}));

import { ForgotPasswordPage } from "./ForgotPassword";

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    requestPasswordResetMock.mockReset();
  });

  it("submits the email and shows the success state regardless of whether the account exists", async () => {
    requestPasswordResetMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordPage />);

    await user.type(
      screen.getByLabelText(/email/i),
      "anybody@halonote.test",
    );
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() =>
      expect(requestPasswordResetMock).toHaveBeenCalledWith({
        email: "anybody@halonote.test",
      }),
    );
    // Doesn't say "we sent an email" — says "if an account exists".
    expect(
      await screen.findByText(/if an account exists/i),
    ).toBeInTheDocument();
  });

  it("surfaces transport errors", async () => {
    requestPasswordResetMock.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText(/email/i), "x@y.test");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
