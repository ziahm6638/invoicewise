import { useQueryStates } from "nuqs";
import { createLoader, parseAsString, parseAsStringLiteral } from "nuqs/server";

export const inboxFilterParamsSchema = {
  q: parseAsString,
  dateFrom: parseAsString,
  dateTo: parseAsString,
  status: parseAsStringLiteral(["done", "pending"]),
  /** Exception state (see `invoiceStateFilters`). */
  state: parseAsStringLiteral([
    "needs_attention",
    "processing",
    "failed",
    "invalid",
    "needs_review",
    "held",
    "delivering",
    "delivery_failed",
    "delivered",
    "corrected",
  ]),
};

export function useInboxFilterParams() {
  const [params, setParams] = useQueryStates(inboxFilterParamsSchema);

  return {
    params,
    setParams,
    hasFilter: Object.values(params).some((value) => value !== null),
  };
}

export const loadInboxFilterParams = createLoader(inboxFilterParamsSchema);
