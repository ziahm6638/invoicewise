"use client";

import { useUserQuery } from "@/hooks/use-user";
import { cn } from "@midday/ui/cn";
import { SubmitButton } from "@midday/ui/submit-button";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const plans = [
  {
    id: "starter",
    name: "Starter",
    price: "$29",
    featured: false,
    features: [
      "Email invoice ingestion",
      "Structured invoice extraction",
      "50 invoices per month",
      "API and webhook delivery",
      "2 team members",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$49",
    featured: true,
    features: [
      "Email invoice ingestion",
      "Structured invoice extraction",
      "500 invoices per month",
      "Custom judgment questions",
      "Accounting and webhook delivery",
      "10 team members",
    ],
  },
] as const;

export function Plans() {
  const [isSubmitting, setIsSubmitting] = useState<string>();
  const { data: user } = useUserQuery();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-7 w-full">
      {plans.map((plan) => (
        <div
          className={cn(
            "flex flex-col p-6 border bg-background",
            plan.featured && "border-primary",
          )}
          key={plan.id}
        >
          <h2 className="text-xl mb-2 text-left">{plan.name}</h2>
          <div className="mt-1 flex items-baseline">
            <span className="text-2xl font-medium tracking-tight">
              {plan.price}
            </span>
            <span className="ml-1 text-xl font-medium">/mo</span>
            <span className="ml-2 text-xs text-muted-foreground">
              Excl. VAT
            </span>
          </div>

          <div className="mt-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-left text-[#878787] font-mono">
              Including
            </h3>
            <ul className="mt-4 space-y-2">
              {plan.features.map((feature) => (
                <li className="flex items-start" key={feature}>
                  <Check className="h-4 w-4 text-primary flex-shrink-0 mr-2" />
                  <span className="text-xs">{feature}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-auto border-t border-border pt-4">
            <Link
              prefetch={false}
              href={`/api/checkout?plan=${plan.id}&teamId=${user?.team?.id}&planType=${plan.id}`}
            >
              <SubmitButton
                className="h-9"
                variant={plan.featured ? "default" : "secondary"}
                onClick={() => setIsSubmitting(plan.id)}
                isSubmitting={isSubmitting === plan.id}
              >
                Choose {plan.name.toLowerCase()} plan
              </SubmitButton>
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
