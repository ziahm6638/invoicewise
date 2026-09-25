import { describe, expect, test } from "bun:test";
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
    expect(inboundMessageKey("<m@x>", "ab12")).toBe("mid:<m@x>");
  });
});

describe("gmail forwarding confirmation", () => {
  test("only Cloudflare's own DKIM pass for google.com is believed", () => {
    expect(
      isGoogleSigned(
        "mx.cloudflare.net; dkim=pass header.d=google.com header.s=20230601; spf=pass smtp.mailfrom=google.com",
      ),
    ).toBe(true);
    expect(
      isGoogleSigned(
        "mx.cloudflare.net;\r\n\tdkim=pass header.i=@google.com header.d=google.com",
      ),
    ).toBe(true);

    for (const results of [
      undefined,
      "",
      "mx.cloudflare.net; dkim=fail header.d=google.com",
      "mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=google.com",
      "mx.cloudflare.net; dkim=pass header.d=evil.example",
      "mx.cloudflare.net; dkim=pass header.d=google.com.evil.example",
      "mx.cloudflare.net; dkim=pass header.d=notgoogle.com",
      // Not added by Cloudflare on receipt.
      "mx.evil.example; dkim=pass header.d=google.com",
    ]) {
      expect(isGoogleSigned(results)).toBe(false);
    }
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
