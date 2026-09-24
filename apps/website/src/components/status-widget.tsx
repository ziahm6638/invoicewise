"use client";

import { fetchStatus } from "@/actions/fetch-status";
import { cn } from "@invoicewise/ui/cn";
import { useEffect, useState } from "react";

type StatusLevel = {
  label: string;
  color: string;
  color2: string;
};

const statusLevels: Record<string, StatusLevel> = {
  operational: {
    label: "Operational",
    color: "bg-green-500",
    color2: "bg-green-400",
  },
  degraded_performance: {
    label: "Degraded Performance",
    color: "bg-yellow-500",
    color2: "bg-yellow-400",
  },
  partial_outage: {
    label: "Partial Outage",
    color: "bg-yellow-500",
    color2: "bg-yellow-400",
  },
  major_outage: {
    label: "Major Outage",
    color: "bg-red-500",
    color2: "bg-red-400",
  },
  unknown: {
    label: "Unknown",
    color: "bg-gray-500",
    color2: "bg-gray-400",
  },
  incident: {
    label: "Incident",
    color: "bg-yellow-500",
    color2: "bg-yellow-400",
  },
  under_maintenance: {
    label: "Under Maintenance",
    color: "bg-gray-500",
    color2: "bg-gray-400",
  },
};

export function StatusWidget() {
  const [status, setStatus] = useState("operational");

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetchStatus();

        if (response) {
          setStatus(response);
        }
      } catch {}
    }

    fetchData();
  }, []);

  const level: StatusLevel | undefined = statusLevels[status];

  if (!level) {
    return null;
  }

  return (
    <a
      className="flex justify-between space-x-2 items-center w-full border border-border rounded-full px-3 py-1.5"
      href="https://midday.openstatus.dev"
      target="_blank"
      rel="noreferrer"
    >
      <div>
        <p className="text-xs font-mono">{level.label}</p>
      </div>

      <span className="relative ml-auto flex h-1.5 w-1.5">
        <span
          className={cn(
            "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
            level.color2,
          )}
        />
        <span
          className={cn(
            "relative inline-flex rounded-full h-1.5 w-1.5",
            level.color,
          )}
        />
      </span>
    </a>
  );
}
