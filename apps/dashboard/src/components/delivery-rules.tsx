"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  CONFIGURABLE_DELIVERY_RULES,
  type ConfigurableDeliveryRule,
  DELIVERY_POLICY_LIMITS,
  DELIVERY_RULE_DESCRIPTIONS,
  type DeliveryCondition,
  type DeliveryPolicy,
  LOCKED_DELIVERY_RULES,
  RECONCILIATION_DELIVERY_RULES,
} from "@invoicewise/documents/delivery-policy";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Checkbox } from "@invoicewise/ui/checkbox";
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
import { useToast } from "@invoicewise/ui/use-toast";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { X } from "lucide-react";
import { useState } from "react";

type Rules = RouterOutputs["deliveryRules"]["get"];
type Question = Rules["questions"][number];

const OPERATOR_LABEL = {
  is: "is",
  is_not: "is not",
  above: "is above",
  below: "is below",
} as const;

const describeCondition = (
  condition: DeliveryCondition,
  questions: readonly Question[],
) => {
  if (condition.kind === "gross_above") {
    return `Gross total is above ${condition.currency} ${condition.amount.toFixed(2)}`;
  }
  const question = questions.find(
    (candidate) => candidate.key === condition.questionKey,
  );
  const value =
    typeof condition.value === "boolean"
      ? condition.value
        ? "Yes"
        : "No"
      : question?.type === "score" && typeof condition.value === "number"
        ? (question.options?.[condition.value] ?? String(condition.value))
        : String(condition.value);
  return `${question?.label ?? `${condition.questionKey} (no longer exists)`} ${OPERATOR_LABEL[condition.operator]} ${value}`;
};

/** The checks over an invoice's reconciliation, listed in their own group. */
const authorizationRules = new Set<string>(RECONCILIATION_DELIVERY_RULES);

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-5 first:pt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RuleRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

/** Adds one condition; the server checks it against the question again. */
function ConditionForm({
  questions,
  onAdd,
}: {
  questions: readonly Question[];
  onAdd: (condition: DeliveryCondition) => void;
}) {
  const [target, setTarget] = useState<string>("gross_above");
  const [operator, setOperator] = useState<string>("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const question = questions.find((candidate) => candidate.key === target);
  const operators =
    target === "gross_above"
      ? []
      : question?.type === "boolean" || question?.type === "choice"
        ? (["is", "is_not"] as const)
        : (["above", "below"] as const);
  const options =
    question?.type === "boolean"
      ? [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ]
      : question?.type === "choice" || question?.type === "score"
        ? (question.options ?? []).map((option, index) => ({
            value: question.type === "score" ? String(index) : option,
            label: option,
          }))
        : null;

  const build = (): DeliveryCondition | null => {
    if (target === "gross_above") {
      const amount = Number(value);
      return value.trim() && Number.isFinite(amount)
        ? { kind: "gross_above", amount, currency: currency.toUpperCase() }
        : null;
    }
    if (!question || !operator || value === "") return null;
    if (operator === "is" || operator === "is_not") {
      return {
        kind: "answer",
        questionKey: question.key,
        operator,
        value: question.type === "boolean" ? value === "true" : value,
      };
    }
    const number = Number(value);
    return Number.isFinite(number)
      ? {
          kind: "answer",
          questionKey: question.key,
          operator: operator as "above" | "below",
          value: number,
        }
      : null;
  };
  const condition = build();

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label className="text-xs" htmlFor="condition-target">
          Hold when
        </Label>
        <Select
          value={target}
          onValueChange={(next) => {
            setTarget(next);
            setOperator("");
            setValue("");
          }}
        >
          <SelectTrigger id="condition-target" className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gross_above">Gross total is above</SelectItem>
            {questions.map((candidate) => (
              <SelectItem key={candidate.key} value={candidate.key}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {operators.length > 0 && (
        <Select value={operator} onValueChange={setOperator}>
          <SelectTrigger className="w-[120px]" aria-label="Comparison">
            <SelectValue placeholder="Comparison" />
          </SelectTrigger>
          <SelectContent>
            {operators.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {OPERATOR_LABEL[candidate]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {options ? (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="w-[160px]" aria-label="Answer">
            <SelectValue placeholder="Answer" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          aria-label={target === "gross_above" ? "Amount" : "Number"}
          inputMode="decimal"
          className="w-[120px]"
          placeholder={target === "gross_above" ? "5000.00" : "0"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      {target === "gross_above" && (
        <Input
          aria-label="Currency"
          className="w-[80px] uppercase"
          maxLength={3}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        />
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!condition}
        onClick={() => {
          if (!condition) return;
          onAdd(condition);
          setValue("");
        }}
      >
        Add condition
      </Button>
    </div>
  );
}

/**
 * The workspace's delivery rules: what is delivered without a person, what
 * is held and why. Every member can read them; owners and admins change
 * them, and each save is a new version (docs/delivery.md#delivery-rules).
 */
export function DeliveryRules() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const permissions = useTeamPermissions();
  const canEdit = permissions.manageDeliveryRules;
  const { data } = useSuspenseQuery(trpc.deliveryRules.get.queryOptions());
  const saved = data.current.policy as DeliveryPolicy;
  const [draft, setDraft] = useState<DeliveryPolicy>(saved);
  const [baseVersion, setBaseVersion] = useState(data.current.version);
  if (baseVersion !== data.current.version) {
    setBaseVersion(data.current.version);
    setDraft(saved);
  }
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation(
    trpc.deliveryRules.update.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.deliveryRules.get.queryKey(),
        });
        toast({
          duration: 3500,
          variant: "success",
          title: `Delivery rules saved as version ${result.version}`,
          description:
            "They apply to invoices processed from now on. Invoices already decided keep their decision.",
        });
      },
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: "The delivery rules were not saved",
          description: error.message,
        }),
    }),
  );

  const questions = data.questions;
  const update = (next: Partial<DeliveryPolicy>) =>
    setDraft((current) => ({ ...current, ...next }));
  const ruleRow = (rule: ConfigurableDeliveryRule) => (
    <RuleRow key={rule} {...DELIVERY_RULE_DESCRIPTIONS[rule]}>
      <Select
        value={draft.rules[rule]}
        disabled={!canEdit}
        onValueChange={(action) =>
          update({
            rules: {
              ...draft.rules,
              [rule]: action as "hold" | "deliver",
            },
          })
        }
      >
        <SelectTrigger
          className="w-[110px]"
          aria-label={DELIVERY_RULE_DESCRIPTIONS[rule].label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="hold">Hold</SelectItem>
          <SelectItem value="deliver">Deliver</SelectItem>
        </SelectContent>
      </Select>
    </RuleRow>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery rules</CardTitle>
        <CardDescription>
          Eligible invoices are delivered automatically. An invoice that meets a
          hold rule waits for an owner or admin, with the exact reason, and is
          never sent silently.{" "}
          {data.current.version === 0
            ? "These are the built-in defaults."
            : `Version ${data.current.version}${
                data.current.createdAt
                  ? `, saved ${formatDistanceToNow(new Date(data.current.createdAt))} ago`
                  : ""
              }${data.current.createdBy?.fullName ? ` by ${data.current.createdBy.fullName}` : ""}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <Section
          title="Destinations"
          description="Where an eligible invoice goes without a manual step."
        >
          <ul className="divide-y">
            <RuleRow
              label="Accounting"
              description="Post eligible invoices to Xero or QuickBooks as draft bills."
            >
              <Switch
                aria-label="Post eligible invoices to accounting"
                checked={draft.destinations.accounting}
                disabled={!canEdit}
                onCheckedChange={(accounting) =>
                  update({
                    destinations: { ...draft.destinations, accounting },
                  })
                }
              />
            </RuleRow>
            <RuleRow
              label="Webhooks"
              description="Which invoices your webhook endpoints receive. Every event carries its delivery decision."
            >
              <Select
                value={draft.destinations.webhooks}
                disabled={!canEdit}
                onValueChange={(webhooks) =>
                  update({
                    destinations: {
                      ...draft.destinations,
                      webhooks: webhooks as "eligible" | "all",
                    },
                  })
                }
              >
                <SelectTrigger className="w-[210px]" aria-label="Webhooks">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="eligible">
                    Eligible invoices only
                  </SelectItem>
                  <SelectItem value="all">Every invoice</SelectItem>
                </SelectContent>
              </Select>
            </RuleRow>
          </ul>
        </Section>

        <Section
          title="Always held"
          description="A bill cannot safely carry these. Correct or re-extract the invoice, or dismiss it."
        >
          <ul className="divide-y">
            {LOCKED_DELIVERY_RULES.map((rule) => (
              <RuleRow key={rule} {...DELIVERY_RULE_DESCRIPTIONS[rule]}>
                <Badge variant="tag-rounded" className="text-xs">
                  Always held
                </Badge>
              </RuleRow>
            ))}
          </ul>
        </Section>

        <Section
          title="Checks"
          description="Hold for a person to release, or deliver as usual."
        >
          <ul className="divide-y">
            {CONFIGURABLE_DELIVERY_RULES.filter(
              (rule) => !authorizationRules.has(rule),
            ).map(ruleRow)}
          </ul>
        </Section>

        <Section
          title="Authorization checks"
          description="Compare each invoice with the job, purchase order or contract it bills. They deliver by default; when one is set to Hold, each invoice is decided once it has been matched and reconciled, and waits until then."
        >
          <ul className="divide-y">
            {RECONCILIATION_DELIVERY_RULES.map(ruleRow)}
          </ul>
        </Section>

        <Section
          title="Required questions"
          description={
            DELIVERY_RULE_DESCRIPTIONS.required_questions.description
          }
        >
          {questions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No questions yet.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {questions.map((question) => {
                const id = `required-${question.key}`;
                const checked = draft.requiredQuestions.includes(question.key);
                return (
                  <li key={question.key} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={
                        !canEdit ||
                        (!checked &&
                          draft.requiredQuestions.length >=
                            DELIVERY_POLICY_LIMITS.maxRequiredQuestions)
                      }
                      onCheckedChange={(next) =>
                        update({
                          requiredQuestions: next
                            ? [...draft.requiredQuestions, question.key]
                            : draft.requiredQuestions.filter(
                                (key) => key !== question.key,
                              ),
                        })
                      }
                    />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {question.label}
                      {!question.enabled && (
                        <span className="text-muted-foreground">
                          {" "}
                          (disabled
                          {checked ? ": holds every invoice until enabled" : ""}
                          )
                        </span>
                      )}
                    </Label>
                  </li>
                );
              })}
            </ul>
          )}
          {draft.requiredQuestions
            .filter(
              (key) => !questions.some((question) => question.key === key),
            )
            .map((key) => (
              <div
                key={key}
                className="mt-2 flex items-center justify-between gap-4 text-xs text-destructive"
              >
                <span>
                  "{key}" is required but was deleted, so every invoice is held
                  until it is removed here.
                </span>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      update({
                        requiredQuestions: draft.requiredQuestions.filter(
                          (other) => other !== key,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
        </Section>

        <Section
          title="Conditions"
          description={`${DELIVERY_RULE_DESCRIPTIONS.conditions.description} An answer that is unknown or uncertain holds the invoice rather than counting as no. Up to ${DELIVERY_POLICY_LIMITS.maxConditions}.`}
        >
          {draft.conditions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conditions.</p>
          ) : (
            <ul className="divide-y">
              {draft.conditions.map((condition, index) => (
                <li
                  // Conditions have no identity beyond their position.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  key={index}
                  className="flex items-center justify-between gap-4 py-2 text-sm"
                >
                  <span>
                    Hold when {describeCondition(condition, questions)}
                  </span>
                  {canEdit && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Remove condition"
                      onClick={() =>
                        update({
                          conditions: draft.conditions.filter(
                            (_, other) => other !== index,
                          ),
                        })
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit &&
            draft.conditions.length < DELIVERY_POLICY_LIMITS.maxConditions && (
              <ConditionForm
                questions={questions}
                onAdd={(condition) =>
                  update({ conditions: [...draft.conditions, condition] })
                }
              />
            )}
        </Section>

        {canEdit ? (
          <div className="flex items-center justify-between gap-4 pt-5">
            <p className="text-xs text-muted-foreground">
              Saving creates version {data.current.version + 1}. Invoices
              already decided keep their decision; nothing is sent again.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!changed || save.isPending}
                onClick={() => setDraft(saved)}
              >
                Discard
              </Button>
              <Button
                size="sm"
                disabled={!changed || save.isPending}
                onClick={() =>
                  save.mutate({
                    expectedVersion: data.current.version,
                    policy: draft as unknown as Record<string, unknown>,
                  })
                }
              >
                Save rules
              </Button>
            </div>
          </div>
        ) : (
          <p className="pt-5 text-xs text-muted-foreground">
            Only workspace owners and admins can change the delivery rules.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
