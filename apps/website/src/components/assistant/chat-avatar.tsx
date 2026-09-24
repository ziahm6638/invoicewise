"use client";

import { Avatar, AvatarImage } from "@invoicewise/ui/avatar";
import { Icons } from "@invoicewise/ui/icons";

type Props = {
  /** Who is speaking in the demo transcript (not an ARIA role). */
  speaker: "assistant" | "user";
};

export function ChatAvatar({ speaker }: Props) {
  switch (speaker) {
    case "user": {
      return (
        <Avatar className="size-6">
          <AvatarImage src="https://pbs.twimg.com/profile_images/1755611130368770048/JwLEqyeo_400x400.jpg" />
        </Avatar>
      );
    }

    default:
      return <Icons.LogoSmall className="size-6" />;
  }
}
