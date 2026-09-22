import type { Client } from "../types";

type UpdateTeamPlanData = {
  id: string;
  plan?: "trial" | "starter" | "pro";
  email?: string | null;
  canceled_at?: string | null;
  subscription_status?:
    | "active"
    | "canceled"
    | "past_due"
    | "unpaid"
    | "trialing"
    | "incomplete"
    | "incomplete_expired"
    | null;
};

export async function updateTeamPlan(
  supabase: Client,
  data: UpdateTeamPlanData,
) {
  const { id, ...rest } = data;

  return supabase
    .from("teams")
    .update(rest)
    .eq("id", id)
    .select("users_on_team(user_id)")
    .single();
}
