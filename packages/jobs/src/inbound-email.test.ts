import { describe, expect, test } from "bun:test";
import { generateInboundLocalPart } from "@invoicewise/db/queries";
import {
  inboundLocalPart,
  inboundMessageKey,
  readInboundEmailHeaders,
} from "./inbound-email";

const DOMAIN = "in.invoicewise.uk";

describe("inbound recipients", () => {
  test("only an issued-shape local part on the receiving domain routes", () => {
    const local = generateInboundLocalPart();
    expect(local).toMatch(/^[a-hj-km-np-z2-9]{16}$/);
    expect(inboundLocalPart(`${local}@${DOMAIN}`, DOMAIN)).toBe(local);
    // Case and a +tag subaddress still route to the same address.
    expect(
      inboundLocalPart(`${local.toUpperCase()}@IN.InvoiceWise.uk`, DOMAIN),
    ).toBe(local);
    expect(inboundLocalPart(`${local}+acme@${DOMAIN}`, DOMAIN)).toBe(local);

    for (const recipient of [
      `${local}@invoicewise.uk`,
      `${local}@evil.example`,
      `${local}@${DOMAIN}.evil.example`,
      `invoices@${DOMAIN}`,
      `${local}x@${DOMAIN}`,
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
