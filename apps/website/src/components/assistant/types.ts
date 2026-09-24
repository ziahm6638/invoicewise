import type { Dispatch, ReactNode, SetStateAction } from "react";

/** One rendered entry in the demo assistant transcript. */
export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  display: ReactNode;
};

export type SubmitMessage = Dispatch<SetStateAction<AssistantMessage[]>>;
