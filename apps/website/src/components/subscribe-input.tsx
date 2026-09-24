"use client";

import { subscribeAction } from "@/actions/subscribe-action";
import { Loader2 } from "lucide-react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();

  if (pending) {
    return (
      <div className="absolute top-1 right-0">
        <Loader2 className="absolute w-4 h-4 mr-3 text-base animate-spin top-2.5 right-2" />
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="absolute right-2 h-7 bg-primary top-2 px-4 font-medium text-sm z-10 text-primary-foreground"
    >
      Join
    </button>
  );
}

export function SubscribeInput() {
  const [state, formAction] = useActionState(subscribeAction, null);

  return (
    <div id="waitlist">
      <div className="flex justify-center">
        {state?.status === "ok" ? (
          <div className="border border-[#2C2C2C] font-sm text-primary h-11 w-[360px] flex items-center py-1 px-3 justify-between">
            <p>You're on the list.</p>

            <svg
              width="17"
              height="17"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>Check</title>
              <path
                d="m14.546 4.724-8 8-3.667-3.667.94-.94 2.727 2.72 7.06-7.053.94.94Z"
                fill="currentColor"
              />
            </svg>
          </div>
        ) : (
          <form action={formAction}>
            <fieldset className="relative">
              <input
                placeholder="Enter your email"
                type="email"
                name="email"
                id="email"
                autoComplete="email"
                aria-label="Email address"
                required
                className="bg-transparent font-sm text-primary outline-none py-1 px-3 w-[360px] placeholder-[#606060] h-11 border border-border"
              />
              <input
                type="text"
                name="company_hp"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="hidden"
              />
              <input type="hidden" name="source" value="website:waitlist" />
              <SubmitButton />
            </fieldset>
          </form>
        )}
      </div>

      {state?.status === "error" && state.message ? (
        <p className="text-xs text-red-500 mt-2 w-[360px]" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
