"use server";

import type { LeadCreateResult } from "@/lib/leads";
import { createLead } from "@/server/leads.server";

export async function subscribeAction(
  _previous: LeadCreateResult | null,
  formData: FormData,
): Promise<LeadCreateResult> {
  return createLead({
    email: String(formData.get("email") ?? ""),
    source: String(formData.get("source") ?? "website:waitlist"),
    company_hp: String(formData.get("company_hp") ?? ""),
    utm_source: String(formData.get("utm_source") ?? ""),
    utm_medium: String(formData.get("utm_medium") ?? ""),
    utm_campaign: String(formData.get("utm_campaign") ?? ""),
    referrer: String(formData.get("referrer") ?? ""),
  });
}
