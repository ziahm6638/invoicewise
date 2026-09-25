import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createFakeSaltEdge } from "./fake-salt-edge";
import {
  SaltEdgeError,
  bankPaymentsAvailability,
  createSaltEdgeClient,
  decimalOf,
  outboundSignatureString,
  saltEdgeCustomerIdentifier,
} from "./salt-edge";

const APP = { appId: "app", secret: "secret" };
const config = {
  ...APP,
  baseUrl: "https://www.saltedge.com/api/v6",
  privateKey: null,
};

describe("bankPaymentsAvailability", () => {
  const base = {
    BANK_PAYMENTS_ENABLED: "true",
    SALT_EDGE_APP_ID: "app",
    SALT_EDGE_SECRET: "secret",
  };
  test("off unless enabled and configured", () => {
    expect(bankPaymentsAvailability({}).available).toBe(false);
    expect(
      bankPaymentsAvailability({ ...base, BANK_PAYMENTS_ENABLED: "yes" })
        .available,
    ).toBe(false);
    expect(
      bankPaymentsAvailability({ ...base, SALT_EDGE_SECRET: "" }).available,
    ).toBe(false);
    expect(bankPaymentsAvailability(base).available).toBe(true);
  });

  test("production needs a signing key, which only a live app uses", () => {
    const production = { ...base, INVOICEWISE_ENVIRONMENT: "production" };
    const refused = bankPaymentsAvailability(production);
    expect(refused).toMatchObject({
      available: false,
      reason: "live_app_required",
    });
    expect(
      bankPaymentsAvailability({ ...production, SALT_EDGE_PRIVATE_KEY: "k" })
        .available,
    ).toBe(true);
  });

  test("customer identifiers keep environments apart", () => {
    expect(
      saltEdgeCustomerIdentifier("t1", { INVOICEWISE_ENVIRONMENT: "staging" }),
    ).toBe("invoicewise-staging-t1");
    expect(saltEdgeCustomerIdentifier("t1", {})).toBe(
      "invoicewise-development-t1",
    );
  });
});

describe("createSaltEdgeClient", () => {
  test("a retried customer creation reuses the existing customer", async () => {
    const fake = createFakeSaltEdge(APP);
    const client = createSaltEdgeClient(config, fake.fetcher);
    const first = await client.createCustomer("invoicewise-staging-t1");
    const again = await client.createCustomer("invoicewise-staging-t1");
    expect(again.id).toBe(first.id);
  });

  test("provider errors keep their class and retryability", async () => {
    const fake = createFakeSaltEdge(APP);
    const wrong = createSaltEdgeClient(
      { ...config, secret: "nope" },
      fake.fetcher,
    );
    const error = await wrong.getConnection("1").catch((value) => value);
    expect(error).toBeInstanceOf(SaltEdgeError);
    expect(error).toMatchObject({
      status: 401,
      errorClass: "WrongClientSecret",
    });
    expect((error as SaltEdgeError).retryable).toBe(false);
    const down = createSaltEdgeClient(config, (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    const network = (await down
      .getConnection("1")
      .catch((value) => value)) as SaltEdgeError;
    expect(network.status).toBe(0);
    expect(network.retryable).toBe(true);
    expect(new SaltEdgeError("gone", 406, "ConsentRevoked").consentGone).toBe(
      true,
    );
  });

  test("removing an already removed connection or customer succeeds", async () => {
    const client = createSaltEdgeClient(
      config,
      createFakeSaltEdge(APP).fetcher,
    );
    await client.removeConnection("404");
    await client.removeCustomer("404");
  });

  test("transactions page by next_id and keep amounts as decimals", async () => {
    const fake = createFakeSaltEdge({ ...APP, pageSize: 2 });
    const client = createSaltEdgeClient(config, fake.fetcher);
    const customer = await client.createCustomer("c");
    const bank = fake.completeConnect({ customerId: customer.id });
    for (const amount of [-0.1, -1200.5, 19.99]) {
      fake.addTransaction(bank.accountId, {
        status: "posted",
        made_on: "2026-09-01",
        amount,
        currency_code: "gbp",
        description: "x",
        extra: { payee: "ACME", end_to_end_id: "E2E-1" },
      });
    }
    const first = await client.listTransactions({
      connectionId: bank.connectionId,
      accountId: bank.accountId,
      pending: false,
    });
    expect(first.transactions.map((row) => row.amount)).toEqual([
      "-0.1",
      "-1200.5",
    ]);
    expect(first.transactions[0]).toMatchObject({
      currency: "GBP",
      counterparty: "ACME",
      reference: "E2E-1",
    });
    const second = await client.listTransactions({
      connectionId: bank.connectionId,
      accountId: bank.accountId,
      pending: false,
      fromId: first.nextId,
    });
    expect(second.transactions.map((row) => row.amount)).toEqual(["19.99"]);
    expect(second.nextId).toBeNull();
    expect(decimalOf(0.1 + 0.2)).toBe("0.3");
  });

  test("a configured private key signs every request", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    let seen: { url: string; headers: Headers; method: string } | null = null;
    const client = createSaltEdgeClient({ ...config, privateKey }, (async (
      url: URL,
      init: RequestInit,
    ) => {
      seen = {
        url: String(url),
        headers: new Headers(init.headers),
        method: String(init.method),
      };
      return Response.json({ data: [], meta: {} });
    }) as unknown as typeof fetch);
    await client.listConsents("7");
    const request = seen as unknown as {
      url: string;
      headers: Headers;
      method: string;
    };
    const verifier = createVerify("SHA256");
    verifier.update(
      outboundSignatureString({
        expiresAt: Number(request.headers.get("Expires-at")),
        method: request.method,
        url: request.url,
        body: "",
      }),
    );
    expect(
      verifier.verify(publicKey, request.headers.get("Signature")!, "base64"),
    ).toBe(true);
  });
});
