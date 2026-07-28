import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../components/Button";
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
    <main id="main" className="page-shell">
      <header className="hero">
        <p className="eyebrow">Kids Channels</p>
        <h1>Create your Household</h1>
        <p>Set up one parent-curated TV Channel and Movie Channel for Stremio.</p>
      </header>
      <form className="card form" noValidate onSubmit={handleSubmit(createHousehold)}>
        <div>
          <label htmlFor="pin">Choose a six-digit Parent PIN</label>
          <p id="pin-help" className="help">Use digits only. You will need this PIN whenever you manage your Household.</p>
          <input
            id="pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            aria-describedby={`pin-help${error ? " pin-error" : ""}`}
            aria-invalid={Boolean(error)}
            {...register("pin")}
          />
          <p id="pin-error" className="field-error" role="alert">{error}</p>
        </div>
        <aside className="warning" aria-label="Important recovery information">
          <strong>Keep your PIN safe.</strong>
          <span> It cannot be recovered if you lose it.</span>
        </aside>
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Creating Household…" : "Create Household"}
        </Button>
      </form>
    </main>
  );
}
