import { describe, expect, test } from "bun:test";
import { createWebhookEndpointSchema } from "./webhooks";

describe("webhook registration schema", () => {
  test("accepts HTTPS endpoints and development localhost listeners", () => {
    expect(
      createWebhookEndpointSchema.safeParse({
        url: "https://customer.example/invoicewise",
        events: ["invoice.processed"],
      }).success,
    ).toBe(true);
    expect(
      createWebhookEndpointSchema.safeParse({
        url: "http://127.0.0.1:3014/invoicewise",
        events: ["delivery.failed"],
      }).success,
    ).toBe(process.env.NODE_ENV !== "production");
  });

  test("rejects insecure remote URLs and embedded credentials", () => {
    expect(
      createWebhookEndpointSchema.safeParse({
        url: "http://customer.example/invoicewise",
        events: ["invoice.processed"],
      }).success,
    ).toBe(false);
    expect(
      createWebhookEndpointSchema.safeParse({
        url: "https://user:password@customer.example/invoicewise",
        events: ["invoice.processed"],
      }).success,
    ).toBe(false);
    expect(
      createWebhookEndpointSchema.safeParse({
        url: "https://10.0.0.1/internal",
        events: ["invoice.processed"],
      }).success,
    ).toBe(process.env.NODE_ENV !== "production");
  });
});
