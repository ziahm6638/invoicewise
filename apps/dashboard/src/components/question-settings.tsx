"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import type {
  RouterInputs,
  RouterOutputs,
} from "@invoicewise/api/trpc/routers/_app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@invoicewise/ui/alert-dialog";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Label } from "@invoicewise/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { Switch } from "@invoicewise/ui/switch";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";

type Question = RouterOutputs["questions"]["list"][number];
type QuestionInput = RouterInputs["questions"]["create"];
type QuestionType = QuestionInput["type"];

const parseOptions = (value: string) =>
  [...new Set(value.split(/[\n,]/).map((option) => option.trim()))].filter(
    Boolean,
  );

function QuestionForm({
  initial,
  isSaving,
  onCancel,
  onSave,
}: {
  initial?: Question;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (input: QuestionInput) => void;
}) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [context, setContext] = useState(initial?.context ?? "");
  const [type, setType] = useState<QuestionType>(initial?.type ?? "boolean");
  const [options, setOptions] = useState(initial?.options?.join("\n") ?? "");
  const parsedOptions = parseOptions(options);
  const questionError =
    question.length > 0 && question.trim().length < 3
      ? "Write at least three characters."
      : null;
  const optionsError =
    type !== "boolean" && options.length > 0 && parsedOptions.length < 2
      ? "Add at least two unique options."
      : null;
  const canSave =
    question.trim().length >= 3 &&
    (type === "boolean" || parsedOptions.length >= 2);

  return (
    <form
      className="space-y-4 border-t bg-secondary/20 px-6 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({
          question: question.trim(),
          context: context.trim() || null,
          type,
          enabled: initial?.enabled ?? true,
          options: type === "boolean" ? null : parsedOptions,
        } as QuestionInput);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`question-${initial?.questionKey ?? "new"}`}>
          Question
        </Label>
        <Textarea
          id={`question-${initial?.questionKey ?? "new"}`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Is this invoice over our director approval threshold?"
          maxLength={500}
          autoFocus
        />
        {questionError && (
          <p className="text-xs text-destructive">{questionError}</p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`answer-type-${initial?.questionKey ?? "new"}`}>
            Answer type
          </Label>
          <Select
            value={type}
            onValueChange={(value: QuestionType) => setType(value)}
          >
            <SelectTrigger id={`answer-type-${initial?.questionKey ?? "new"}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="boolean">Yes or no</SelectItem>
              <SelectItem value="choice">Choose one option</SelectItem>
              <SelectItem value="score">Score / probability</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {type !== "boolean" && (
          <div className="space-y-2">
            <Label htmlFor={`options-${initial?.questionKey ?? "new"}`}>
              {type === "choice" ? "Choices" : "Score levels"}
            </Label>
            <Textarea
              id={`options-${initial?.questionKey ?? "new"}`}
              value={options}
              onChange={(event) => setOptions(event.target.value)}
              placeholder={
                type === "choice"
                  ? "Capital spend\nOperational spend"
                  : "Low\nMedium\nHigh"
              }
              maxLength={1_000}
            />
            <p className="text-xs text-muted-foreground">
              One option per line.
            </p>
            {optionsError && (
              <p className="text-xs text-destructive">{optionsError}</p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`context-${initial?.questionKey ?? "new"}`}>
          Business context <span className="font-normal">(optional)</span>
        </Label>
        <Textarea
          id={`context-${initial?.questionKey ?? "new"}`}
          value={context}
          onChange={(event) => setContext(event.target.value)}
          placeholder="Director approval is required for new suppliers over £500."
          maxLength={2_000}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave || isSaving}>
          {isSaving ? "Saving…" : initial ? "Save changes" : "Add question"}
        </Button>
      </div>
    </form>
  );
}

export function QuestionSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const permissions = useTeamPermissions();
  // Questions are workspace configuration: owner/admin only, server-enforced.
  const canManage = permissions.manageQuestions;
  const { data: questions } = useSuspenseQuery(
    trpc.questions.list.queryOptions(),
  );
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.questions.list.queryKey(),
    });
  const reportError = (error: { message: string }) =>
    toast({
      title: "Question change failed",
      description: error.message,
      variant: "destructive",
    });
  const createQuestion = useMutation(
    trpc.questions.create.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setIsAdding(false);
      },
      onError: reportError,
    }),
  );
  const updateQuestion = useMutation(
    trpc.questions.update.mutationOptions({
      onSuccess: async () => {
        await refresh();
        setEditingKey(null);
      },
      onError: reportError,
    }),
  );
  const deleteQuestion = useMutation(
    trpc.questions.delete.mutationOptions({
      onSuccess: refresh,
      onError: reportError,
    }),
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-6 space-y-0">
        <div>
          <CardTitle>What should InvoiceWise check?</CardTitle>
          <CardDescription>
            These questions are answered whenever an invoice is processed.
            Changes create a new version, so older answers keep their original
            wording.
          </CardDescription>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditingKey(null);
              setIsAdding(true);
            }}
            disabled={isAdding}
          >
            Add question
          </Button>
        )}
      </CardHeader>

      {isAdding && (
        <QuestionForm
          initial={undefined}
          isSaving={createQuestion.isPending}
          onCancel={() => setIsAdding(false)}
          onSave={(input) => createQuestion.mutate(input)}
        />
      )}

      <CardContent className="p-0">
        <div className="divide-y border-t">
          {questions.map((question) => (
            <div key={question.questionKey}>
              <div className="flex items-start gap-4 px-6 py-5">
                <Switch
                  aria-label={`${question.enabled ? "Disable" : "Enable"} ${question.label}`}
                  checked={question.enabled}
                  disabled={!canManage || updateQuestion.isPending}
                  onCheckedChange={(enabled) =>
                    updateQuestion.mutate({
                      questionKey: question.questionKey,
                      question: question.question,
                      context: question.context,
                      type: question.type,
                      options:
                        question.type === "boolean"
                          ? null
                          : (question.options ?? []),
                      enabled,
                    } as RouterInputs["questions"]["update"])
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{question.label}</p>
                    {question.isDefault && <Badge variant="tag">Default</Badge>}
                    <span className="text-xs text-muted-foreground">
                      v{question.version}
                    </span>
                  </div>
                  {question.label !== question.question && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {question.question}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {question.type === "boolean"
                      ? "Yes or no"
                      : question.type === "choice"
                        ? `Choose: ${question.options?.join(", ")}`
                        : `Score: ${question.options?.join(" → ")}`}
                  </p>
                  {question.context && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Context: {question.context}
                    </p>
                  )}
                </div>
                {canManage && !question.isDefault && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setIsAdding(false);
                        setEditingKey(question.questionKey);
                      }}
                    >
                      Edit
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost">
                          Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete this question?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Existing invoice answers will remain available with
                            this version of the question.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              deleteQuestion.mutate({
                                questionKey: question.questionKey,
                              })
                            }
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
              {editingKey === question.questionKey && (
                <QuestionForm
                  initial={question}
                  isSaving={updateQuestion.isPending}
                  onCancel={() => setEditingKey(null)}
                  onSave={(input) =>
                    updateQuestion.mutate({
                      questionKey: question.questionKey,
                      ...input,
                    } as RouterInputs["questions"]["update"])
                  }
                />
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
