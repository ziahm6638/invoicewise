"use client";

import { useEffect, useRef } from "react";

type EventType = "INSERT" | "UPDATE" | "DELETE" | "*";
type RealtimePayload = {
  eventType: Exclude<EventType, "*">;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

interface UseRealtimeProps {
  channelName: string;
  event?: EventType;
  table: string;
  filter?: string;
  onEvent: (payload: RealtimePayload) => void;
}

export function useRealtime({
  channelName,
  event = "*",
  table,
  filter,
  onEvent,
}: UseRealtimeProps) {
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (filter === undefined) return;

    const timer = window.setInterval(() => {
      onEventRef.current({
        eventType: event === "*" ? "UPDATE" : event,
        new: { priority: 1 },
        old: {},
      });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [channelName, event, table, filter]);
}
