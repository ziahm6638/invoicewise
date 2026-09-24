import type { TZDate } from "@date-fns/tz";
import {
  differenceInDays,
  differenceInMonths,
  format,
  parseISO,
  startOfDay,
} from "date-fns";

export function formatSize(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

  const unitIndex = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );

  return Intl.NumberFormat("en-US", {
    style: "unit",
    unit: units[unitIndex],
  }).format(+Math.round(bytes / 1024 ** unitIndex));
}

type FormatAmountParams = {
  currency: string;
  amount: number;
  locale?: string | null;
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
};

export function formatAmount({
  currency,
  amount,
  locale = "en-US",
  minimumFractionDigits,
  maximumFractionDigits,
}: FormatAmountParams) {
  if (!currency) {
    return;
  }

  // Fix: locale can be null, but Intl.NumberFormat expects string | string[] | undefined
  // So, if locale is null, pass undefined instead
  const safeLocale = locale ?? undefined;

  return Intl.NumberFormat(safeLocale, {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(amount);
}

export function secondsToHoursAndMinutes(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }

  if (hours) {
    return `${hours}h`;
  }

  if (minutes) {
    return `${minutes}m`;
  }

  return "0m";
}

type BurnRateData = {
  value: number;
  date: string;
};

export function calculateAvgBurnRate(data: BurnRateData[] | null) {
  if (!data) {
    return 0;
  }

  return data?.reduce((acc, curr) => acc + curr.value, 0) / data?.length;
}

/** UK, day-first: the display format for anyone without their own preference. */
export const DEFAULT_DATE_FORMAT = "dd/MM/yyyy";

/** The date formats a user may choose; none of them puts the month first. */
export const DATE_FORMATS = [
  DEFAULT_DATE_FORMAT,
  "yyyy-MM-dd",
  "dd.MM.yyyy",
] as const;

const DISPLAY_DATE_FORMATS = new Set<string>([...DATE_FORMATS, "d MMM yyyy"]);

/**
 * Formats a date for display in the user's chosen format, or UK day-first
 * (24/09/2026) by default; never the US month-first order, so any other stored
 * format falls back to the default. A date-only value
 * such as an invoice date (`2026-09-24`) is a calendar day, so it is read in
 * local time rather than as UTC midnight, which would shift it a day west of
 * Greenwich.
 */
export function formatDate(date: string | Date, dateFormat?: string | null) {
  const value =
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? parseISO(date)
      : new Date(date);
  if (Number.isNaN(value.getTime())) return String(date);
  return format(
    value,
    dateFormat && DISPLAY_DATE_FORMATS.has(dateFormat)
      ? dateFormat
      : DEFAULT_DATE_FORMAT,
  );
}

export function getInitials(value: string) {
  const formatted = value.toUpperCase().replace(/[\s.-]/g, "");

  if (formatted.split(" ").length > 1) {
    return `${formatted.charAt(0)}${formatted.charAt(1)}`;
  }

  if (value.length > 1) {
    return formatted.charAt(0) + formatted.charAt(1);
  }

  return formatted.charAt(0);
}

export function formatAccountName({
  name = "",
  currency,
}: { name?: string; currency?: string | null }) {
  if (currency) {
    return `${name} (${currency})`;
  }

  return name;
}

export function formatDateRange(dates: TZDate[]): string {
  if (!dates.length) return "";

  const formatFullDate = (date: TZDate) => format(date, "d MMM");
  const formatDay = (date: TZDate) => format(date, "d");

  const startDate = dates[0];
  const endDate = dates[1];

  if (!startDate) return "";

  if (
    dates.length === 1 ||
    !endDate ||
    startDate.getTime() === endDate.getTime()
  ) {
    return formatFullDate(startDate);
  }

  if (startDate.getMonth() === endDate.getMonth()) {
    // Same month
    return `${formatDay(startDate)} - ${formatDay(endDate)} ${format(startDate, "MMM")}`;
  }
  // Different months
  return `${formatFullDate(startDate)} - ${formatFullDate(endDate)}`;
}

export function getDueDateStatus(dueDate: string): string {
  const now = new Date();
  const due = new Date(dueDate);

  // Set both dates to the start of their respective days
  const nowDay = startOfDay(now);
  const dueDay = startOfDay(due);

  const diffDays = differenceInDays(dueDay, nowDay);
  const diffMonths = differenceInMonths(dueDay, nowDay);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";

  if (diffDays > 0) {
    if (diffMonths < 1) return `in ${diffDays} days`;
    return `in ${diffMonths} month${diffMonths === 1 ? "" : "s"}`;
  }

  if (diffMonths < 1)
    return `${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? "" : "s"} ago`;
  return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return "just now";
  }

  const intervals = [
    { label: "y", seconds: 31536000 },
    { label: "mo", seconds: 2592000 },
    { label: "d", seconds: 86400 },
    { label: "h", seconds: 3600 },
    { label: "m", seconds: 60 },
  ] as const;

  for (const interval of intervals) {
    const count = Math.floor(diffInSeconds / interval.seconds);
    if (count > 0) {
      return `${count}${interval.label} ago`;
    }
  }

  return "just now";
}
