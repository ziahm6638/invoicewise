"use client";

import { cn } from "@invoicewise/ui/cn";
import {
  ClipboardCheck,
  FileText,
  ListChecks,
  Send,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { path: "/invoices", name: "Invoices", icon: FileText, disabled: false },
  {
    path: "/authorizations",
    name: "Authorizations",
    icon: ClipboardCheck,
    disabled: false,
  },
  {
    path: "/questions",
    name: "Questions",
    icon: ListChecks,
    disabled: false,
  },
  { path: "/delivery", name: "Delivery", icon: Send, disabled: true },
  { path: "/settings", name: "Settings", icon: Settings, disabled: false },
] as const;

type Props = {
  onSelect?: () => void;
  isExpanded?: boolean;
};

export function MainMenu({ onSelect, isExpanded = false }: Props) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="mt-6 w-full px-[15px]">
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive =
            pathname === item.path ||
            (item.path === "/authorizations" &&
              pathname.startsWith("/authorizations/")) ||
            (item.path === "/invoices" && pathname === "/inbox") ||
            (item.path === "/settings" &&
              pathname.startsWith("/settings") &&
              pathname !== "/questions");
          const content = (
            <div
              className={cn(
                "flex h-10 items-center rounded-sm border border-transparent transition-colors",
                isExpanded ? "px-3" : "justify-center",
                isActive &&
                  "border-[#DCDAD2] bg-[#F2F1EF] text-primary dark:border-[#2C2C2C] dark:bg-secondary",
                item.disabled
                  ? "cursor-not-allowed text-muted-foreground/50"
                  : "text-[#666] hover:text-primary dark:text-[#888]",
              )}
            >
              <Icon aria-hidden className="size-5 shrink-0" />
              {isExpanded && (
                <span className="ml-3 whitespace-nowrap text-sm font-medium">
                  {item.name}
                </span>
              )}
              {isExpanded && item.disabled && (
                <span className="ml-auto text-[10px] uppercase tracking-wide">
                  Soon
                </span>
              )}
            </div>
          );

          if (item.disabled) {
            return (
              <div
                key={item.path}
                aria-disabled="true"
                title="Delivery configuration is being added separately"
              >
                {content}
              </div>
            );
          }

          return (
            <Link key={item.path} prefetch href={item.path} onClick={onSelect}>
              {content}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
