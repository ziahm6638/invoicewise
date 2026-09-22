import { cn } from "@invoicewise/ui/cn";
import { Skeleton } from "@invoicewise/ui/skeleton";

type InboxSkeletonProps = {
  numberOfItems: number;
  className?: string;
};

export function InboxListSkeleton({
  numberOfItems,
  className,
}: InboxSkeletonProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      {[...Array(numberOfItems)].map((_, index) => (
        <div
          className="flex h-[112px] flex-col items-start gap-2 border-b p-4 text-left text-sm"
          key={index.toString()}
        >
          <div className="flex w-full flex-col gap-1">
            <div className="flex items-center mb-4">
              <div className="flex items-center gap-2">
                <div className="font-semibold">
                  <Skeleton className="h-3 w-[140px]" />
                </div>
              </div>
              <div className="ml-auto text-xs text-muted-foreground">
                <Skeleton className="h-3 w-[40px]" />
              </div>
            </div>
            <div className="flex">
              <div className="text-xs font-medium">
                <Skeleton className="h-2 w-[110px]" />
              </div>
              <div className="ml-auto text-xs font-medium">
                <Skeleton className="h-2 w-[60px]" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
