import { useQueryStates } from "nuqs";
import { createLoader, parseAsString, parseAsStringLiteral } from "nuqs/server";

export const inboxFilterParamsSchema = {
  q: parseAsString,
  dateFrom: parseAsString,
  dateTo: parseAsString,
  status: parseAsStringLiteral(["done", "pending"]),
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
