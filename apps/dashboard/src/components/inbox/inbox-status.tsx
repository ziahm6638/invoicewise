"use client";

import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Icons } from "@midday/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";

type Props = {
  item: RouterOutputs["inbox"]["get"]["data"][number];
};

export function InboxStatus({ item }: Props) {
  // Don't show status for processing items - let skeleton handle the visual feedback
  if (item.status === "processing" || item.status === "new") {
    return null;
  }

  if (item.status === "pending") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="p-1 text-[10px] px-1.5 py-0.5 cursor-default font-mono inline-block border">
              <span>Pending</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>This invoice is ready for review.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (item.status === "done") {
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex space-x-1 items-center px-1.5 py-0.5 text-[10px] cursor-default font-mono border">
              <Icons.Check className="size-3.5 mt-[1px]" />
              <span>Reviewed</span>
            </div>
          </TooltipTrigger>
          <TooltipContent sideOffset={10} className="text-xs">
            <p>This invoice has been reviewed.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex space-x-1 items-center px-1.5 py-0.5 text-[10px] cursor-default font-mono border">
            <span>{item.status}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent sideOffset={10} className="text-xs">
          <p>This invoice is awaiting review.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
