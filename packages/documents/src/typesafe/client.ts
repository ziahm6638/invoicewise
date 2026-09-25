import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

export type TypeSafeQuestion =
  | {
      type: "noul";
      instructions: unknown;
      criteria?: { true?: unknown; false?: unknown };
    }
  | {
      type: "choice";
      instructions: unknown;
      criteria: Record<string, unknown>;
    }
  | {
      type: "score";
      instructions: unknown;
      criteria: readonly unknown[];
    };

export type TypeSafeAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type TypeSafeResponse = {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage: { inputTokens: number; outputTokens: number };
};

export class TypeSafeError extends Schema.TaggedError<TypeSafeError>()(
  "TypeSafeError",
  {
    reason: Schema.String,
    status: Schema.optional(Schema.Number),
    retryable: Schema.Boolean,
    /** The reason safe to show the customer; absent for internal failures. */
    userMessage: Schema.optional(Schema.String),
  },
) {}

export class TypeSafe extends Context.Tag("invoicewise/TypeSafe")<
  TypeSafe,
  {
    readonly evaluate: (input: {
      state: unknown;
      questions: Record<string, TypeSafeQuestion>;
    }) => Effect.Effect<TypeSafeResponse, TypeSafeError>;
  }
>() {}

const NumberRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Number,
});

const WireAnswer = Schema.Union(
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: NumberRecord,
    confidence: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    legend: Schema.Record({ key: Schema.String, value: Schema.String }),
    probabilities: NumberRecord,
    confidence: Schema.Number,
  }),
);

const WireResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record({ key: Schema.String, value: WireAnswer }),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
  }),
});

const responseError = (status: number): TypeSafeError =>
  new TypeSafeError({
    reason:
      status === 401
        ? "TypeSafe authentication failed"
        : status === 403
          ? "TypeSafe request was forbidden"
          : status === 422
            ? "TypeSafe rejected the request"
            : status === 429
              ? "TypeSafe rate limit exceeded"
              : "TypeSafe request failed",
    status,
    retryable: status === 429 || status >= 500,
  });

/**
 * One finished TypeSafe call: timing, outcome and token usage only. The
 * request and response bodies are never part of the event.
 */
export type TypeSafeCallEvent = {
  durationMs: number;
  outcome: "ok" | "failed" | "throttled";
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type TypeSafeCallObserver = (event: TypeSafeCallEvent) => void;

let processCallObserver: TypeSafeCallObserver | undefined;

/**
 * Registers the process-wide observer every TypeSafe client reports to (the
 * workflow runner records provider usage with it). Pass `undefined` to stop.
 */
export const observeTypeSafeCalls = (
  observer: TypeSafeCallObserver | undefined,
) => {
  processCallObserver = observer;
};

const notify = (
  observer: TypeSafeCallObserver | undefined,
  event: TypeSafeCallEvent,
) => {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Metering must never change the outcome of the call it measures.
  }
};

export const makeTypeSafe = (config: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
  /** Defaults to the process-wide observer from `observeTypeSafeCalls`. */
  onCall?: TypeSafeCallObserver;
}): TypeSafe["Type"] => ({
  evaluate: (input) =>
    Effect.suspend(() => {
      const startedAt = performance.now();
      const observer = config.onCall ?? processCallObserver;
      const elapsed = () => performance.now() - startedAt;
      return requestTypeSafe(config, input).pipe(
        Effect.tap((response) =>
          Effect.sync(() =>
            notify(observer, {
              durationMs: elapsed(),
              outcome: "ok",
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
            }),
          ),
        ),
        Effect.tapError((error) =>
          Effect.sync(() =>
            notify(observer, {
              durationMs: elapsed(),
              outcome: error.status === 429 ? "throttled" : "failed",
              status: error.status,
            }),
          ),
        ),
      );
    }),
});

const requestTypeSafe = (
  config: {
    apiKey: string;
    baseUrl: string;
    model: string;
    fetch?: typeof fetch;
  },
  {
    state,
    questions,
  }: { state: unknown; questions: Record<string, TypeSafeQuestion> },
): Effect.Effect<TypeSafeResponse, TypeSafeError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await (config.fetch ?? fetch)(
        `${config.baseUrl.replace(/\/$/, "")}/v1/systemone`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, model: config.model, questions }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) throw responseError(response.status);
      return response.json() as Promise<unknown>;
    },
    catch: (error) =>
      error instanceof TypeSafeError
        ? error
        : new TypeSafeError({
            reason: "TypeSafe is unavailable",
            retryable: true,
          }),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknown(WireResponse)(value).pipe(
        Effect.mapError(
          () =>
            new TypeSafeError({
              reason: "TypeSafe returned an invalid response",
              retryable: false,
            }),
        ),
      ),
    ),
    Effect.map((response) => ({
      model: response.model,
      answers: response.answers,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    })),
  );

export const TypeSafeLive = Layer.effect(
  TypeSafe,
  Config.all({
    apiKey: Config.redacted("TYPESAFE_API_KEY"),
    baseUrl: Config.string("TYPESAFE_BASE_URL").pipe(
      Config.withDefault("https://api.typesafe.ai"),
    ),
    model: Config.string("TYPESAFE_MODEL").pipe(
      Config.withDefault("jev-latest"),
    ),
  }).pipe(
    Effect.map((config) =>
      makeTypeSafe({
        apiKey: Redacted.value(config.apiKey),
        baseUrl: config.baseUrl,
        model: config.model,
      }),
    ),
  ),
);
