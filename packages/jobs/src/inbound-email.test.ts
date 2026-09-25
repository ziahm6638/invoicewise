import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateInboundLocalPart } from "@invoicewise/db/queries";
import {
  inboundEmailLive,
  inboundLocalPart,
  inboundMessageKey,
  isGoogleSigned,
  readInboundEmailHeaders,
} from "./inbound-email";

const DOMAIN = "in.invoicewise.uk";

describe("inbound recipients", () => {
  test("only an issued-shape local part on the receiving domain routes", () => {
    const local = generateInboundLocalPart();
    expect(local).toMatch(/^[a-hj-km-np-z2-9]{16}$/);
    expect(inboundLocalPart(`${local}@${DOMAIN}`, DOMAIN)).toBe(local);
    // Case does not matter.
    expect(
      inboundLocalPart(`${local.toUpperCase()}@IN.InvoiceWise.uk`, DOMAIN),
    ).toBe(local);

    for (const recipient of [
      `${local}@invoicewise.uk`,
      `${local}@evil.example`,
      `${local}@${DOMAIN}.evil.example`,
      `invoices@${DOMAIN}`,
      `${local}x@${DOMAIN}`,
      // Only the exact issued local part routes, never a subaddress.
      `${local}+acme@${DOMAIN}`,
      `${local}+@${DOMAIN}`,
      `@${DOMAIN}`,
      local,
      "",
    ]) {
      expect(inboundLocalPart(recipient, DOMAIN)).toBeNull();
    }
  });

  test("issued local parts do not repeat", () => {
    const issued = new Set(
      Array.from({ length: 2000 }, () => generateInboundLocalPart()),
    );
    expect(issued.size).toBe(2000);
  });
});

describe("inbound headers", () => {
  const raw = (headers: string, body = "body") =>
    new TextEncoder().encode(`${headers}\r\n\r\n${body}`);

  test("identity and audit headers are read from the header section only", async () => {
    const headers = await readInboundEmailHeaders(
      raw(
        [
          "Authentication-Results: mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
          "From: =?utf-8?q?Acme_Supplies?= <Billing@Acme.example>",
          "To: abc@in.invoicewise.uk",
          "Subject: =?utf-8?q?Invoice_=C2=A3120?=",
          "Date: Tue, 22 Sep 2026 10:00:00 +0100",
          "Message-ID: <inv-42@acme.example>",
        ].join("\r\n"),
        // A body that is not valid MIME never affects acknowledgement.
        "--broken\r\nContent-Type: multipart/mixed; boundary=\r\n",
      ),
    );
    expect(headers).toEqual({
      messageId: "<inv-42@acme.example>",
      from: "Acme Supplies <Billing@Acme.example>",
      fromAddress: "billing@acme.example",
      subject: "Invoice £120",
      date: "2026-09-22T09:00:00.000Z",
      authenticationResults:
        "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
    });
  });

  test("a message without a Message-ID is keyed by its bytes", async () => {
    const headers = await readInboundEmailHeaders(raw("Subject: hi"));
    expect(headers.messageId).toBeNull();
    expect(inboundMessageKey(headers.messageId, "ab12")).toBe("sha256:ab12");
    const key = inboundMessageKey("<m@x>", "ab12");
    expect(key).toBe(
      `mid:${createHash("sha256").update("<m@x>").digest("hex")}`,
    );
    expect(key).not.toContain("m@x");
  });
});

describe("gmail forwarding confirmation", () => {
  // Cloudflare's receipt block as observed in production on 2026-09-25
  // (docs/inbound-email.md, live proof step 7), for a message from Google.
  const CF_RECEIVED = {
    key: "received",
    value:
      "from mail-sor-f41.google.com (209.85.220.41)\r\n        by cloudflare-email.net (cloudflare) id AuYfoj6x77E4\r\n        for <u4833cja7jktx258@in.invoicewise.uk>; Fri, 25 Sep 2026 05:07:50 +0000",
  };
  const PASS =
    "mx.cloudflare.net;\r\n\tdkim=pass header.d=google.com header.s=20230601 header.b=abc;\r\n\tdmarc=pass header.from=google.com policy.dmarc=reject;\r\n\tspf=pass smtp.mailfrom=forwarding-noreply@google.com";
  const header = (key: string, value: string) => ({ key, value });
  const cloudflareBlock = (results: string) => [
    CF_RECEIVED,
    header(
      "arc-seal",
      "i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none; b=x",
    ),
    header(
      "arc-message-signature",
      "i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; b=x",
    ),
    header("arc-authentication-results", `i=1; ${results}`),
    header(
      "received-spf",
      "pass (mx.cloudflare.net: domain of forwarding-noreply@google.com designates 209.85.220.41 as permitted sender)",
    ),
    header("authentication-results", results),
    header("x-cf-spamh-score", "0"),
  ];
  const senderHeaders = [
    header(
      "dkim-signature",
      "v=1; a=rsa-sha256; d=google.com; s=20230601; b=x",
    ),
    header(
      "received",
      "by 2002:a05:6214:... with SMTP id ...; Fri, 25 Sep 2026 05:07:40 +0000",
    ),
    header("from", "Gmail Team <forwarding-noreply@google.com>"),
  ];

  test("the observed Cloudflare layout with a DKIM pass for google.com is believed", () => {
    expect(isGoogleSigned([...cloudflareBlock(PASS), ...senderHeaders])).toBe(
      true,
    );
    // Either of Cloudflare's two results is enough.
    const onlyArc = cloudflareBlock(PASS).filter(
      ({ key }) => key !== "authentication-results",
    );
    expect(isGoogleSigned([...onlyArc, ...senderHeaders])).toBe(true);
    const onlyResults = cloudflareBlock(PASS).filter(
      ({ key }) => key !== "arc-authentication-results",
    );
    expect(isGoogleSigned([...onlyResults, ...senderHeaders])).toBe(true);
  });

  test("Cloudflare's results must show DKIM pass for google.com itself", () => {
    for (const value of [
      "mx.cloudflare.net; dkim=fail header.d=google.com",
      "mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=google.com",
      "mx.cloudflare.net; dkim=pass header.d=evil.example",
      "mx.cloudflare.net; dkim=pass header.d=google.com.evil.example",
      "mx.cloudflare.net; dkim=pass header.d=notgoogle.com",
      "mx.evil.example; dkim=pass header.d=google.com",
    ]) {
      expect(
        isGoogleSigned([...cloudflareBlock(value), ...senderHeaders]),
      ).toBe(false);
    }
  });

  test("a forged mx.cloudflare.net pass placed after Cloudflare's block is ignored", () => {
    const failing = "mx.cloudflare.net; dkim=pass header.d=evil.example";
    const forged = [
      ...cloudflareBlock(failing),
      // What a sender writes into its own message ends up here.
      header("authentication-results", PASS),
      header("arc-authentication-results", `i=1; ${PASS}`),
      ...senderHeaders,
    ];
    expect(isGoogleSigned(forged)).toBe(false);
  });

  test("without Cloudflare's Received on top nothing is believed", () => {
    expect(isGoogleSigned([])).toBe(false);
    // Results with no receipt header at all.
    expect(
      isGoogleSigned([
        header("authentication-results", PASS),
        ...senderHeaders,
      ]),
    ).toBe(false);
    // A sender's own Received on top, claiming the same results.
    expect(
      isGoogleSigned([
        header("received", "from mail.evil.example by mx.evil.example"),
        ...cloudflareBlock(PASS).slice(1),
      ]),
    ).toBe(false);
    // Cloudflare's block present but not first.
    expect(
      isGoogleSigned([
        header("x-injected", "1"),
        ...cloudflareBlock(PASS),
        ...senderHeaders,
      ]),
    ).toBe(false);
    // A later ARC instance is not Cloudflare's receipt.
    expect(
      isGoogleSigned([
        CF_RECEIVED,
        header("arc-authentication-results", `i=2; ${PASS}`),
        ...senderHeaders,
      ]),
    ).toBe(false);
  });
});

describe("going live", () => {
  test("the address is shown only once INBOUND_EMAIL_LIVE is true", () => {
    expect(inboundEmailLive({})).toBe(false);
    expect(inboundEmailLive({ INBOUND_EMAIL_LIVE: "false" })).toBe(false);
    expect(inboundEmailLive({ INBOUND_EMAIL_LIVE: "1" })).toBe(false);
    expect(inboundEmailLive({ INBOUND_EMAIL_LIVE: " TRUE " })).toBe(true);
  });
});
