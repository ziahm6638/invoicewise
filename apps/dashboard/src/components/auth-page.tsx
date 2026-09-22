import { Icons } from "@midday/ui/icons";

export function AuthPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-4 text-center">
          <Icons.LogoSmall className="mx-auto h-9 w-auto" />
          <div>
            <h1 className="font-serif text-2xl">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
