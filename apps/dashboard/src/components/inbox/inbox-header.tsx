"use client";

import { InboxOrdering } from "@/components/inbox/inbox-ordering";
import { InboxSearch } from "@/components/inbox/inbox-search";
import { Button } from "@midday/ui/button";
import { Upload } from "lucide-react";

export function InboxHeader() {
  return (
    <div className="mb-3 mt-4 flex w-full items-center gap-3">
      <InboxSearch />
      <InboxOrdering />
      <Button
        className="shrink-0"
        onClick={() => document.getElementById("upload-files")?.click()}
      >
        <Upload aria-hidden className="mr-2 size-4" />
        <span className="hidden sm:inline">Upload invoice</span>
        <span className="sm:hidden">Upload</span>
      </Button>
    </div>
  );
}
