import { getAppUrl } from "@invoicewise/utils/envs";
import { Hr, Link, Section, Text } from "@react-email/components";
import { LogoFooter } from "./logo-footer";
import { getEmailInlineStyles, getEmailThemeClasses } from "./theme";

export function Footer() {
  const themeClasses = getEmailThemeClasses();
  const lightStyles = getEmailInlineStyles("light");

  return (
    <Section className="w-full">
      <Hr
        className={themeClasses.border}
        style={{ borderColor: lightStyles.container.borderColor }}
      />

      <br />

      <Text
        className={`text-[21px] font-regular ${themeClasses.text}`}
        style={{ color: lightStyles.text.color }}
      >
        Invoices in. Structured data out.
      </Text>

      <br />

      <Text
        className={`text-xs ${themeClasses.secondaryText}`}
        style={{ color: lightStyles.secondaryText.color }}
      >
        InvoiceWise - invoicewise.uk.
      </Text>

      <Link
        className={`text-[14px] block ${themeClasses.mutedLink}`}
        href={`${getAppUrl()}/account`}
        style={{ color: lightStyles.mutedText.color }}
      >
        Account settings
      </Link>

      <br />
      <br />

      <LogoFooter />
    </Section>
  );
}
