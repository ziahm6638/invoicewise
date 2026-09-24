export const BUILT_IN_CHECK_DESCRIPTIONS: Record<string, string> = {
  likely_duplicate: "This invoice may duplicate one already received.",
  known_supplier: "This supplier has sent invoices before.",
  bank_details_consistent:
    "Bank details match earlier invoices from this supplier.",
  vat_calculation_correct: "VAT adds up correctly for the net amount.",
};

export function checkDescription({
  isBuiltIn,
  key,
  label,
  question,
}: {
  isBuiltIn: boolean;
  key: string;
  label: string;
  question: string;
}) {
  if (isBuiltIn) return BUILT_IN_CHECK_DESCRIPTIONS[key] ?? null;
  return question !== label ? question : null;
}
