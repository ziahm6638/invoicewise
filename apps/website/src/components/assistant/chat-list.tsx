"use client";

import type { AssistantMessage } from "./types";

type Props = {
  messages: AssistantMessage[];
};

export function ChatList({ messages }: Props) {
  if (!messages.length) {
    return null;
  }

  return (
    <div className="flex flex-col  p-4 pb-8">
      {messages
        .filter((message) => message.display !== undefined)
        .map((message, index) => (
          <div key={message.id}>
            {message.display}
            {index < messages.length - 1 && <div className="my-6" />}
          </div>
        ))}
    </div>
  );
}
