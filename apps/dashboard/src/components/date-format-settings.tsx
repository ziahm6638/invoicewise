"use client";

import { useUserMutation, useUserQuery } from "@/hooks/use-user";
import { DATE_FORMATS, DEFAULT_DATE_FORMAT } from "@/utils/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";

export function DateFormatSettings() {
  const { data: user } = useUserQuery();
  const updateUserMutation = useUserMutation();

  return (
    <Card className="flex justify-between items-center">
      <CardHeader>
        <CardTitle>Date Display Format</CardTitle>
        <CardDescription>
          Select the format used to display dates throughout the app.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Select
          defaultValue={
            DATE_FORMATS.find((value) => value === user?.dateFormat) ??
            DEFAULT_DATE_FORMAT
          }
          onValueChange={(value) => {
            updateUserMutation.mutate({
              dateFormat: value as (typeof DATE_FORMATS)[number],
            });
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Date format" />
          </SelectTrigger>
          <SelectContent>
            {DATE_FORMATS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  );
}
