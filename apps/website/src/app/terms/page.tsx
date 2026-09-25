import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: "Terms and Conditions for InvoiceWise",
};

export default function Page() {
  return (
    <div className="max-w-[720px] m-auto my-20 leading-7">
      <h1 className="text-2xl tracking-tight lg:text-3xl">
        Terms and Conditions
      </h1>

      <p className="mt-8 text-sm text-[#878787]">
        Last updated: 25 September 2026
      </p>

      <p className="mt-8">
        These terms govern your use of the InvoiceWise application and website
        (the "Service"), operated by SortX Software Ltd ("we", "us"), a company
        registered in England and Wales, company number 17132612, registered
        office Flat 9 Lowood House, Bewley Street, London E1 0BT.
      </p>

      <p className="mt-4">
        By using the Service you agree to these terms. If you do not agree,
        please do not use the Service.
      </p>

      <h2 className="mt-10 text-xl font-medium">1. The Service</h2>
      <p className="mt-4">
        InvoiceWise receives invoices by email, extracts structured data from
        them, answers questions you configure, and delivers the result to the
        destination you choose, such as an accounting system or an API. We are
        not an invoicing system, an accounting system, or a payment provider,
        and we do not create or pay invoices.
      </p>

      <h2 className="mt-10 text-xl font-medium">2. Accounts</h2>
      <p className="mt-4">
        You must provide accurate information when you create an account and
        keep your credentials secure. You are responsible for activity under
        your account. Tell us promptly if you believe your account has been
        compromised.
      </p>

      <h2 className="mt-10 text-xl font-medium">3. Your data</h2>
      <p className="mt-4">
        You keep ownership of the documents you send us and the data extracted
        from them. You give us permission to process them to provide the
        Service. You must have the right to send us any document you upload, and
        you must not send us data you are not permitted to share.
      </p>

      <h2 className="mt-10 text-xl font-medium">4. Fees</h2>
      <p className="mt-4">
        Early access is provided free of charge while the product is in
        development. When paid plans are introduced we will give clear notice of
        the price and billing cycle before you are charged.
      </p>

      <h2 className="mt-10 text-xl font-medium">5. No professional advice</h2>
      <p className="mt-4">
        InvoiceWise extracts and judgement features are automated and can be
        wrong. We are not your accountant, bookkeeper, or tax adviser, and
        nothing in the Service is financial, legal, or tax advice. You are
        responsible for checking data before you rely on it.
      </p>

      <h2 className="mt-10 text-xl font-medium">6. Acceptable use</h2>
      <p className="mt-4">
        Do not use the Service to break the law, infringe anyone's rights, send
        us data you are not allowed to, or interfere with the Service or other
        users. We may suspend an account that puts the Service or others at
        risk.
      </p>

      <h2 className="mt-10 text-xl font-medium">7. Availability and changes</h2>
      <p className="mt-4">
        The Service is provided "as is" and "as available". We work to keep it
        reliable and secure but we do not promise it will be uninterrupted or
        error-free, and we may change or withdraw features. We may update these
        terms; material changes will be announced on this page.
      </p>

      <h2 className="mt-10 text-xl font-medium">8. Liability</h2>
      <p className="mt-4">
        To the extent allowed by law, we are not liable for indirect or
        consequential loss, or for loss of profit, data, or goodwill arising
        from your use of the Service. Nothing in these terms limits liability
        that cannot be limited by law.
      </p>

      <h2 className="mt-10 text-xl font-medium">9. Termination</h2>
      <p className="mt-4">
        You can stop using the Service at any time. We may suspend or end your
        access if you breach these terms or if we discontinue the Service.
      </p>

      <h2 className="mt-10 text-xl font-medium">10. Governing law</h2>
      <p className="mt-4">
        These terms are governed by the laws of England and Wales, and the
        courts of England and Wales have exclusive jurisdiction.
      </p>

      <h2 className="mt-10 text-xl font-medium">11. Contact</h2>
      <p className="mt-4">
        <a href="mailto:hello@invoicewise.uk" className="underline">
          hello@invoicewise.uk
        </a>
      </p>
    </div>
  );
}
