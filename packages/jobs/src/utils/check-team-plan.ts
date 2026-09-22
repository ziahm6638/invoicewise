import { createClient } from "@midday/db/legacy-client";

export async function shouldSendEmail(teamId: string) {
  const database = createClient();

  const { data, error } = await database
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .eq("plan", "trial")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (data) {
    return true;
  }

  return false;
}
