"use client";

import {
  useTeamMutation,
  useTeamPermissions,
  useTeamQuery,
} from "@/hooks/use-team";
import { useZodForm } from "@/hooks/use-zod-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@invoicewise/ui/form";
import { Input } from "@invoicewise/ui/input";
import { SubmitButton } from "@invoicewise/ui/submit-button";
import { z } from "zod";

const formSchema = z.object({
  name: z.string().min(2).max(32),
});

export function CompanyName() {
  const { data } = useTeamQuery();
  const permissions = useTeamPermissions();
  const updateTeamMutation = useTeamMutation();

  const form = useZodForm(formSchema, {
    defaultValues: {
      name: data?.name ?? "",
    },
  });

  const onSubmit = form.handleSubmit((data) => {
    updateTeamMutation.mutate(data);
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Company name</CardTitle>
            <CardDescription>
              This is your company's visible name within InvoiceWise. For
              example, the name of your company or department.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      {...field}
                      className="max-w-[300px]"
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck="false"
                      maxLength={32}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>

          <CardFooter className="flex justify-between">
            <div>Please use 32 characters at maximum.</div>
            <SubmitButton
              isSubmitting={updateTeamMutation.isPending}
              disabled={
                !permissions.manageWorkspaceSettings ||
                updateTeamMutation.isPending
              }
            >
              Save
            </SubmitButton>
          </CardFooter>
        </Card>
      </form>
    </Form>
  );
}
