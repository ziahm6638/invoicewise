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
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Input } from "@invoicewise/ui/input";
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
import { QuestionPreview } from "./question-preview";
import { QuestionSummary } from "./question-summary";

type Question = RouterOutputs["questions"]["list"][number];
type QuestionInput = RouterInputs["questions"]["create"];
type QuestionType = QuestionInput["type"];
type NumberUnit = "currency" | "percent" | "days" | "count" | "other";

const UNIT_LABELS: Record<NumberUnit, string> = {
  currency: "Money (invoice currency)",
  percent: "Percentage",
  days: "Days",
  count: "Count",
  other: "Other unit",
};

const parseBound = (value: string) => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** Mirrors the server's range rules so mistakes show before saving. */
function rangeError(unit: NumberUnit, min: number | null, max: number | null) {
  if (Number.isNaN(min) || Number.isNaN(max)) return "Enter numbers only.";
  if (min !== null && max !== null && min > max) {
    return "The maximum must not be below the minimum.";
  }
  const bounds = [min, max].filter((value): value is number => value !== null);
  if (
    (unit === "days" || unit === "count") &&
    bounds.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    return "Days and counts are whole numbers of zero or more.";
  }
  if (
    unit === "percent" &&
    bounds.some((value) => value < -100 || value > 1000)
  ) {
    return "A percentage range must lie between -100 and 1000.";
  }
  return null;
}

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
  const [unit, setUnit] = useState<NumberUnit>(
    initial?.numberFormat?.unit ?? "currency",
  );
  const [unitLabel, setUnitLabel] = useState(
    initial?.numberFormat?.unitLabel ?? "",
  );
  const [min, setMin] = useState(initial?.numberFormat?.min?.toString() ?? "");
  const [max, setMax] = useState(initial?.numberFormat?.max?.toString() ?? "");
  const [previewing, setPreviewing] = useState(false);
  const parsedOptions = parseOptions(options);
  const numberError =
    type === "number"
      ? (rangeError(unit, parseBound(min), parseBound(max)) ??
        (unit === "other" && !unitLabel.trim()
          ? "Name the unit, for example kg or hours."
          : null))
      : null;
  const questionError =
    question.length > 0 && question.trim().length < 3
      ? "Write at least three characters."
      : null;
  const hasOptions = type === "choice" || type === "score";
  const optionsError =
    hasOptions && options.length > 0 && parsedOptions.length < 2
      ? "Add at least two unique options."
      : null;
  const canSave =
    question.trim().length >= 3 &&
    (!hasOptions || parsedOptions.length >= 2) &&
    !numberError;
  const current = {
    question: question.trim(),
    context: context.trim() || null,
    type,
    enabled: initial?.enabled ?? true,
    options: hasOptions ? parsedOptions : null,
    numberFormat:
      type === "number"
        ? {
            unit,
            unitLabel: unit === "other" ? unitLabel.trim() : null,
            min: parseBound(min),
            max: parseBound(max),
          }
        : null,
  } as QuestionInput;

  return (
    <form
      className="space-y-4 border-t bg-secondary/20 px-6 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave(current);
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
              <SelectItem value="number">Number</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {type === "number" && (
          <div className="space-y-2">
            <Label htmlFor={`unit-${initial?.questionKey ?? "new"}`}>
              Unit
            </Label>
            <Select
              value={unit}
              onValueChange={(value: NumberUnit) => setUnit(value)}
            >
              <SelectTrigger id={`unit-${initial?.questionKey ?? "new"}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(UNIT_LABELS) as NumberUnit[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {UNIT_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-3 gap-2">
              {unit === "other" && (
                <Input
                  aria-label="Unit name"
                  placeholder="kg"
                  value={unitLabel}
                  maxLength={20}
                  onChange={(event) => setUnitLabel(event.target.value)}
                />
              )}
              <Input
                aria-label="Minimum"
                placeholder="Min"
                inputMode="decimal"
                value={min}
                onChange={(event) => setMin(event.target.value)}
              />
              <Input
                aria-label="Maximum"
                placeholder="Max"
                inputMode="decimal"
                value={max}
                onChange={(event) => setMax(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The answer is a value printed on the invoice within this range, or
              Unknown when none is.
            </p>
            {numberError && (
              <p className="text-xs text-destructive">{numberError}</p>
            )}
          </div>
        )}
        {hasOptions && (
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

      {previewing && canSave && (
        <QuestionPreview
          questionKey={initial?.questionKey}
          draft={current}
          canRerun={false}
        />
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!canSave}
          onClick={() => setPreviewing((value) => !value)}
        >
          {previewing ? "Hide preview" : "Preview draft"}
        </Button>
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
  const [tryingKey, setTryingKey] = useState<string | null>(null);
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
            Changes create a new version: answers already given keep the
            wording, options and version they were made with until you rerun the
            question on chosen invoices.
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
                        question.type === "choice" || question.type === "score"
                          ? (question.options ?? [])
                          : null,
                      numberFormat:
                        question.type === "number"
                          ? question.numberFormat
                          : null,
                      enabled,
                    } as RouterInputs["questions"]["update"])
                  }
                />
                <QuestionSummary question={question} />
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setTryingKey((key) =>
                        key === question.questionKey
                          ? null
                          : question.questionKey,
                      )
                    }
                  >
                    {tryingKey === question.questionKey
                      ? "Close"
                      : "Try on invoices"}
                  </Button>
                )}
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
              {tryingKey === question.questionKey && (
                <QuestionPreview
                  questionKey={question.questionKey}
                  canRerun={question.enabled}
                />
              )}
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
