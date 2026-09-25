import type {
  AuthorizationSourceVersion,
  getAuthorizationSource,
  listAuthorizationSources,
} from "@invoicewise/db/queries";
import { authorizationSourceGaps } from "@invoicewise/documents/authorization-source";

type SourceList = Awaited<ReturnType<typeof listAuthorizationSources>>;
type SourceDetail = NonNullable<
  Awaited<ReturnType<typeof getAuthorizationSource>>
>;

/** One version as the dashboard, tRPC and REST return it. */
export const presentAuthorizationVersion = (
  version: AuthorizationSourceVersion,
) => ({
  id: version.id,
  sourceId: version.sourceId,
  version: version.version,
  status: version.status,
  title: version.title,
  scope: version.scope,
  supplier: version.supplierId
    ? { id: version.supplierId, name: version.supplierName }
    : null,
  suppliedSupplier: version.suppliedSupplier,
  supplierResolution: version.supplierResolution,
  currency: version.currency,
  taxBasis: version.taxBasis,
  issuedOn: version.issuedOn,
  startsOn: version.startsOn,
  endsOn: version.endsOn,
  effectiveFrom: version.effectiveFrom,
  authorizedTotal: version.authorizedTotal,
  lines: version.lineItems as {
    reference: string | null;
    description: string;
    quantity: string | null;
    unitPrice: string | null;
    amount: string;
  }[],
  changeReason: version.changeReason,
  origin: version.origin,
  importId: version.importId,
  recordedBy: version.actorName,
  recordedAt: version.createdAt,
  gaps: authorizationSourceGaps(version),
});

export const presentAuthorizationSourceList = (list: SourceList) => ({
  data: list.data.map((row) => ({
    id: row.id,
    type: row.type,
    reference: row.reference,
    status: row.status,
    title: row.title,
    version: row.version,
    supplier: row.supplierId
      ? { id: row.supplierId, name: row.supplierName }
      : null,
    suppliedSupplierName: row.suppliedSupplierName,
    currency: row.currency,
    authorizedTotal: row.authorizedTotal,
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    gaps: authorizationSourceGaps({
      supplierId: row.supplierId,
      currency: row.currency,
    }),
  })),
  meta: list.meta,
});

export const presentAuthorizationSource = (source: SourceDetail) => ({
  id: source.id,
  type: source.type,
  reference: source.reference,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
  current: presentAuthorizationVersion(source.current),
  versions: source.versions.map((version) => ({
    id: version.id,
    version: version.version,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    authorizedTotal: version.authorizedTotal,
    currency: version.currency,
    changeReason: version.changeReason,
    origin: version.origin,
    recordedBy: version.actorName,
    recordedAt: version.createdAt,
  })),
  documents: source.documents,
});
