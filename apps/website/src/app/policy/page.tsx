import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How InvoiceWise handles personal data",
};

export default function Page() {
  return (
    <div className="max-w-[720px] m-auto my-20 leading-7">
      <h1 className="text-2xl tracking-tight lg:text-3xl">Privacy Policy</h1>

      <p className="mt-8 text-sm text-[#878787]">
        Last updated: 25 September 2026
      </p>

      <p className="mt-8">
        InvoiceWise is operated by SortX Software Ltd ("we", "us"), a company
        registered in England and Wales, company number 17132612, registered
        office Flat 9 Lowood House, Bewley Street, London E1 0BT. This page
        explains what we collect on{" "}
        <a href="https://invoicewise.uk" className="underline">
          invoicewise.uk
        </a>{" "}
        and in the InvoiceWise application, and why.
      </p>

      <h2 className="mt-10 text-xl font-medium">What the website collects</h2>
      <p className="mt-4">
        When you join the waitlist we store the email address you enter, the
        page or form you used, any campaign parameters in the link you arrived
        through, the referring page, your browser's user agent string, and a
        salted, one-way hash of your IP address. The hash lets us rate-limit
        abusive submissions; we cannot reverse it to your IP address.
      </p>
      <p className="mt-4">
        This data is stored in our own PocketBase instance on a server we
        operate. We use it to email you about early access and to understand
        interest in the product. We do not sell it or share it for advertising.
      </p>

      <h2 className="mt-10 text-xl font-medium">Email</h2>
      <p className="mt-4">
        We send the waitlist confirmation and our internal notification over
        Purelymail SMTP. Emails are sent from an invoicewise.uk address. You can
        ask us to delete your waitlist entry at any time.
      </p>

      <h2 className="mt-10 text-xl font-medium">The application</h2>
      <p className="mt-4">
        If you use the InvoiceWise app, we process the invoices you send us, the
        data extracted from them, the answers to the questions you configure,
        and the account and workspace details needed to operate the service. We
        keep the original document alongside the extracted data so every field
        can be traced back to its source.
      </p>
      <p className="mt-4">
        If you connect a mailbox such as Gmail, we request read access only to
        the messages needed to find and process invoices. Data received from
        Google APIs is used solely to provide the service, is never sold or used
        for advertising, and is not used to train generalised AI or machine
        learning models.
      </p>

      <h2 className="mt-10 text-xl font-medium">Cookies</h2>
      <p className="mt-4">
        The marketing site does not set advertising or analytics cookies. The
        application sets the session cookies required to keep you signed in.
      </p>

      <h2 className="mt-10 text-xl font-medium">Legal basis</h2>
      <p className="mt-4">
        If you are in the UK or EEA, we process this data because it is
        necessary to provide the service you have asked for, because you have
        consented (the waitlist), and because we have a legitimate interest in
        keeping the service secure and understanding demand.
      </p>

      <h2 className="mt-10 text-xl font-medium">Your rights</h2>
      <p className="mt-4">
        You can ask us for a copy of the personal data we hold about you, ask us
        to correct or delete it, object to processing, or withdraw consent at
        any time. Email{" "}
        <a href="mailto:hello@invoicewise.uk" className="underline">
          hello@invoicewise.uk
        </a>{" "}
        and we will respond. You also have the right to complain to the
        Information Commissioner's Office in the UK.
      </p>

      <h2 className="mt-10 text-xl font-medium">Retention</h2>
      <p className="mt-4">
        We keep waitlist entries until you ask us to remove them or until they
        are no longer useful. Application data is kept for as long as your
        workspace is active, plus any period we are legally required to keep for
        accounting.
      </p>

      <h2 className="mt-10 text-xl font-medium">Changes</h2>
      <p className="mt-4">
        If we change this policy we will update the date at the top and, for
        material changes, tell signed-in users by email.
      </p>

      <h2 className="mt-10 text-xl font-medium">Contact</h2>
      <p className="mt-4">
        Questions about privacy:{" "}
        <a href="mailto:hello@invoicewise.uk" className="underline">
          hello@invoicewise.uk
        </a>
        .
      </p>
    </div>
  );
}
