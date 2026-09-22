import { redirect } from "next/navigation";

export default function InboxSettingsRedirect() {
  redirect("/settings/email");
}
