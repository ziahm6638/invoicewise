import { describe, expect, test } from "bun:test";
import {
  AUTH_RATE_LIMIT_RULES,
  LOCAL_AUTH_SECRET,
  assertProductionAuthConfig,
  isAuthRateLimitEnabled,
  mailAddress,
  productionAuthConfigProblems,
  resolveAuthSecret,
} from "./auth-policy";

const production = (overrides: Record<string, string | undefined> = {}) =>
  ({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "a".repeat(48),
    BETTER_AUTH_URL: "https://app.invoicewise.uk",
    ALLOWED_API_ORIGINS: "https://app.invoicewise.uk",
    BETTER_AUTH_COOKIE_DOMAIN: ".invoicewise.uk",
    SMTP_USER: "auth@invoicewise.uk",
    AUTH_EMAIL_FROM: "InvoiceWise <auth@invoicewise.uk>",
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe("production auth preflight", () => {
  test("the production configuration passes", () => {
    expect(productionAuthConfigProblems(production())).toEqual([]);
    expect(() => assertProductionAuthConfig(production())).not.toThrow();
  });

  test("a missing, local or short secret is refused", () => {
    expect(
      productionAuthConfigProblems(
        production({ BETTER_AUTH_SECRET: undefined }),
      ),
    ).toEqual(["BETTER_AUTH_SECRET is required"]);
    expect(
      productionAuthConfigProblems(
        production({ BETTER_AUTH_SECRET: LOCAL_AUTH_SECRET }),
      ),
    ).toEqual(["BETTER_AUTH_SECRET must not be the local development secret"]);
    expect(
      productionAuthConfigProblems(production({ BETTER_AUTH_SECRET: "short" })),
    ).toEqual(["BETTER_AUTH_SECRET must be at least 32 characters"]);
  });

  test("plain-http origins are refused, loopback is accepted", () => {
    expect(
      productionAuthConfigProblems(
        production({
          BETTER_AUTH_URL: "http://app.invoicewise.uk",
          BETTER_AUTH_COOKIE_DOMAIN: undefined,
        }),
      ),
    ).toEqual(["BETTER_AUTH_URL must use https"]);
    expect(
      productionAuthConfigProblems(
        production({
          ALLOWED_API_ORIGINS:
            "https://app.invoicewise.uk,http://evil.example.com",
        }),
      ),
    ).toEqual(["ALLOWED_API_ORIGINS entries must be https origins"]);
    expect(
      productionAuthConfigProblems(
        production({
          BETTER_AUTH_URL: "http://localhost:3001",
          ALLOWED_API_ORIGINS: "http://127.0.0.1:3001",
          BETTER_AUTH_COOKIE_DOMAIN: undefined,
        }),
      ),
    ).toEqual([]);
  });

  test("the cookie domain must cover the auth origin", () => {
    expect(
      productionAuthConfigProblems(
        production({ BETTER_AUTH_COOKIE_DOMAIN: ".example.com" }),
      ),
    ).toEqual(["BETTER_AUTH_COOKIE_DOMAIN must cover BETTER_AUTH_URL"]);
  });

  test("the sender must be on the verified SMTP mailbox's domain", () => {
    expect(
      productionAuthConfigProblems(
        production({ AUTH_EMAIL_FROM: "InvoiceWise <auth@resend.dev>" }),
      ),
    ).toEqual(["AUTH_EMAIL_FROM must be on the SMTP_USER mailbox's domain"]);
    expect(
      productionAuthConfigProblems(production({ AUTH_EMAIL_FROM: undefined })),
    ).toEqual(["AUTH_EMAIL_FROM must be a valid sender address"]);
    expect(
      productionAuthConfigProblems(production({ SMTP_USER: "not-an-address" })),
    ).toEqual(["SMTP_USER must be the sending mailbox address"]);
  });

  test("every problem is named in one error, without values", () => {
    const secret = "short-secret-value";
    let message = "";

    try {
      assertProductionAuthConfig(
        production({
          BETTER_AUTH_SECRET: secret,
          BETTER_AUTH_URL: "http://app.invoicewise.uk",
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("BETTER_AUTH_SECRET must be at least");
    expect(message).toContain("BETTER_AUTH_URL must use https");
    expect(message).not.toContain(secret);
  });
});

describe("development shortcuts", () => {
  test("the local secret is used only outside production", () => {
    expect(resolveAuthSecret({ NODE_ENV: "development" })).toBe(
      LOCAL_AUTH_SECRET,
    );
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(
      "BETTER_AUTH_SECRET is required in production",
    );
    expect(
      resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: " s " }),
    ).toBe("s");
  });

  test("rate limiting cannot be switched off in production", () => {
    expect(isAuthRateLimitEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(
      isAuthRateLimitEnabled({
        NODE_ENV: "production",
        AUTH_RATE_LIMIT: "off",
      }),
    ).toBe(true);
    expect(isAuthRateLimitEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(
      isAuthRateLimitEnabled({
        NODE_ENV: "test",
        AUTH_RATE_LIMIT: "enforce",
      }),
    ).toBe(true);
  });
});

describe("rate-limit rules", () => {
  test("every credential, token and second-factor path is budgeted", () => {
    for (const path of [
      "/sign-in/*",
      "/sign-up/*",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/verify-email",
      "/change-password",
      "/change-email",
      "/two-factor/*",
    ]) {
      expect(AUTH_RATE_LIMIT_RULES).toHaveProperty([path]);
    }
  });
});

describe("mailAddress", () => {
  test("reads display-name and bare forms", () => {
    expect(mailAddress("InvoiceWise <Auth@InvoiceWise.uk>")).toBe(
      "auth@invoicewise.uk",
    );
    expect(mailAddress("auth@invoicewise.uk")).toBe("auth@invoicewise.uk");
    expect(mailAddress("InvoiceWise")).toBeNull();
  });
});
