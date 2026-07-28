import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Ident } from "../components/Ident";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { apiErrorMessage, parentApi } from "../lib/parent-api";

const schema = z.object({
  pin: z.string().regex(/^\d{6}$/, "Enter exactly six digits."),
});

type FormValues = z.infer<typeof schema>;

type CreatedHousehold = { parentUrl: string };

export const Route = createFileRoute("/")({ component: CreateHouseholdPage });

function CreateHouseholdPage() {
  const navigate = useNavigate();
  const createMutation = useMutation({
    mutationFn: (values: FormValues) => parentApi<CreatedHousehold>("/api/households", { method: "POST", body: values }),
  });
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { pin: "" },
  });

  async function createHousehold(values: FormValues) {
    try {
      const result = await createMutation.mutateAsync(values);
      const secret = new URL(result.parentUrl, window.location.origin).pathname.split("/").at(-1);
      if (!secret) throw new Error("The private Parent Page URL was missing.");
      await navigate({ to: "/households/$secret/onboarding", params: { secret } });
    } catch {
      // TanStack Query retains the error for the inline form message.
    }
  }

  const error = errors.pin?.message || (createMutation.isError
    ? apiErrorMessage(createMutation.error, "Household creation is temporarily unavailable. Try again.")
    : "");
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-16">
      <header className="mb-8">
        <Ident className="mb-3">Kids Channels</Ident>
        <h1 className="max-w-[18ch] text-[clamp(2rem,7vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance">Create your Household</h1>
        <p className="mt-3 max-w-[43rem] leading-relaxed text-muted-foreground">Set up one parent-curated TV Channel and Movie Channel for Stremio.</p>
      </header>
      <form className="grid gap-5 rounded-[4px] border bg-card p-6" noValidate onSubmit={handleSubmit(createHousehold)}>
        <div>
          <label htmlFor="pin" className="text-sm font-semibold">Choose a six-digit Parent PIN</label>
          <p id="pin-help" className="mt-1 text-sm leading-relaxed text-muted-foreground">Use digits only. You will need this PIN whenever you manage your Household.</p>
          <Input
            id="pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            aria-describedby={`pin-help${error ? " pin-error" : ""}`}
            aria-invalid={Boolean(error)}
            className="mt-2 h-12 font-mono text-xl tracking-[0.3em]"
            {...register("pin")}
          />
          <p id="pin-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{error}</p>
        </div>
        <aside className="rounded-[4px] border border-warning-border bg-warning-bg p-4 text-sm leading-relaxed text-warning-text" aria-label="Important recovery information">
          <strong className="font-semibold">Keep your PIN safe.</strong>
          <span> It cannot be recovered if you lose it.</span>
        </aside>
        <Button type="submit" size="lg" className="w-full" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Creating Household…" : "Create Household"}
        </Button>
      </form>
    </main>
  );
}
