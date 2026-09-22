import { QuestionSettings } from "@/components/question-settings";
import { prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Questions | InvoiceWise",
};

export default function QuestionsPage() {
  prefetch(trpc.questions.list.queryOptions());
  return (
    <main className="max-w-[900px] pt-4">
      <QuestionSettings />
    </main>
  );
}
