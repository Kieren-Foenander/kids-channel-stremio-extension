import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { InstallationDetails } from "../components/InstallationDetails";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { apiErrorMessage, ParentApiError, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/settings")({ component: SettingsPage });

const pinSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/, "Enter your current six-digit PIN."),
  newPin: z.string().regex(/^\d{6}$/, "Enter a new six-digit PIN."),
}).superRefine((values, context) => {
  if (/^\d{6}$/.test(values.currentPin) && values.currentPin === values.newPin) {
    context.addIssue({ code: "custom", path: ["newPin"], message: "Choose a new PIN that differs from the current PIN." });
  }
});

const deletionSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/, "Enter your current six-digit PIN."),
  confirmation: z.string().refine((value: string): boolean => value === "DELETE", "Type DELETE exactly to confirm permanent deletion."),
});

type PinValues = z.infer<typeof pinSchema>;
type DeletionValues = z.infer<typeof deletionSchema>;
type PinResponse = { message: string };

function SettingsPage() {
  const { secret } = Route.useParams();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const form = useForm<PinValues>({
    resolver: zodResolver(pinSchema),
    defaultValues: { currentPin: "", newPin: "" },
  });
  const deletionForm = useForm<DeletionValues>({
    resolver: zodResolver(deletionSchema),
    defaultValues: { currentPin: "", confirmation: "" },
  });
  const rotation = useMutation({
    mutationFn: (values: PinValues) => parentApi<PinResponse>(`/api/households/${secret}/pin`, {
      method: "PUT",
      body: values,
    }),
  });
  const deletion = useMutation({
    mutationFn: (values: DeletionValues) => parentApi<PinResponse>(`/api/households/${secret}`, {
      method: "DELETE",
      body: values,
    }),
  });

  async function changePin(values: PinValues) {
    if (rotation.isPending) return;
    setResult(null);
    try {
      const response = await rotation.mutateAsync(values);
      form.reset();
      queryClient.setQueryData(parentKeys.session(secret), { authenticated: true, expiresIn: 60 * 60 });
      setResult({ kind: "success", message: response.message });
    } catch (error) {
      setResult({ kind: "error", message: apiErrorMessage(error, "The Parent PIN could not be changed. Try again.") });
    }
  }

  async function permanentlyDelete(values: DeletionValues) {
    if (deletion.isPending) return;
    setDeletionError("");
    try {
      await deletion.mutateAsync(values);
      deletionForm.reset();
      queryClient.removeQueries({ queryKey: ["household", secret] });
      window.dispatchEvent(new Event("household-deleted"));
    } catch (error) {
      const message = apiErrorMessage(error, "The Household could not be deleted. Nothing was removed. Try again.");
      if (error instanceof ParentApiError && (error.status === 401 || error.status === 429)) {
        deletionForm.setError("currentPin", { message }, { shouldFocus: true });
      } else if (error instanceof ParentApiError && error.status === 400 && error.message.includes("DELETE")) {
        deletionForm.setError("confirmation", { message }, { shouldFocus: true });
      } else {
        setDeletionError(message);
      }
    }
  }

  function setDeletionDialog(open: boolean) {
    if (deletion.isPending) return;
    setDeletionOpen(open);
    setDeletionError("");
    deletionForm.reset();
  }

  return (
    <div className="grid gap-12">
      <PageHeader ident="Parent Page" title="Settings" description="Revisit installation details and manage secure Parent access." />

      <section id="installation" className="scroll-mt-4" aria-labelledby="settings-installation-heading">
        <div className="mb-4">
          <h2 id="settings-installation-heading" className="text-xl font-semibold tracking-[-0.01em]">Install your Household addon</h2>
          <p className="mt-1 max-w-[46rem] text-sm leading-relaxed text-muted-foreground">Use the same private installation details on the Stremio account shared by your Household devices.</p>
        </div>
        <InstallationDetails secret={secret} />
      </section>

      <section className="grid gap-4 rounded-[4px] border bg-card p-5 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1.35fr)] md:gap-8" aria-labelledby="stream-addon-heading">
        <h2 id="stream-addon-heading" className="text-xl font-semibold tracking-[-0.01em]">Configure a separate stream addon</h2>
        <div className="grid content-start gap-3 text-sm leading-relaxed text-muted-foreground">
          <p>Kids Channels schedules programmes but does not provide or inspect streams. Install and configure a stream addon such as Comet separately in Stremio.</p>
          <p>For the simplest source choice, prefer cached 1080p results and keep the number of returned results low. Stream availability and source selection remain inside Stremio.</p>
        </div>
      </section>

      <section className="grid gap-4 rounded-[4px] border bg-card p-5 md:grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)] md:gap-8" aria-labelledby="parent-access-heading">
        <div>
          <h2 id="parent-access-heading" className="text-xl font-semibold tracking-[-0.01em]">Parent access</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">There is no forgotten-PIN or Household recovery. Changing the PIN signs out every previous Parent session while keeping this browser signed in.</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">To end this browser's access immediately, use <strong className="font-semibold text-foreground">Lock Parent Page</strong> in the navigation.</p>
        </div>
        <form className="grid content-start gap-4" noValidate onSubmit={form.handleSubmit(changePin)}>
          <div>
            <label htmlFor="current-pin" className="text-sm font-semibold">Current PIN</label>
            <Input id="current-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} aria-invalid={Boolean(form.formState.errors.currentPin)} aria-describedby="current-pin-error" className="mt-2 font-mono tracking-[0.3em]" {...form.register("currentPin")} />
            <p id="current-pin-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{form.formState.errors.currentPin?.message}</p>
          </div>
          <div>
            <label htmlFor="new-pin" className="text-sm font-semibold">New six-digit PIN</label>
            <Input id="new-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} aria-invalid={Boolean(form.formState.errors.newPin)} aria-describedby="new-pin-error" className="mt-2 font-mono tracking-[0.3em]" {...form.register("newPin")} />
            <p id="new-pin-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{form.formState.errors.newPin?.message}</p>
          </div>
          <Button type="submit" className="w-fit" disabled={rotation.isPending}>{rotation.isPending ? "Changing PIN…" : "Change Parent PIN"}</Button>
          <p id="pin-status" className={result?.kind === "error" ? "min-h-5 text-sm font-medium text-destructive" : "min-h-5 text-sm font-medium text-accent"} role={result?.kind === "error" ? "alert" : "status"} aria-live="polite">{result?.message}</p>
        </form>
      </section>

      <section className="border-t border-destructive/40 pt-10" aria-labelledby="danger-zone-heading">
        <div className="mb-4 max-w-[46rem]">
          <h2 id="danger-zone-heading" className="text-xl font-semibold tracking-[-0.01em] text-destructive">Permanently delete Household</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Deletion removes the Approved Library, Show Progress, Channel Schedules, Current Programmes, playback history, PIN, Parent sessions, and synced addon access. It cannot be undone.</p>
        </div>
        <Dialog open={deletionOpen} onOpenChange={setDeletionDialog}>
          <DialogTrigger asChild><Button type="button" variant="destructive">Delete Household…</Button></DialogTrigger>
          <DialogContent className="sm:max-w-lg" showCloseButton={!deletion.isPending} onEscapeKeyDown={(event) => deletion.isPending && event.preventDefault()} onPointerDownOutside={(event) => deletion.isPending && event.preventDefault()}>
            <DialogHeader>
              <DialogTitle>Delete Household permanently?</DialogTitle>
              <DialogDescription>This removes every programme and all Channel state. Stremio and every Parent session will immediately lose access. This action cannot be undone.</DialogDescription>
            </DialogHeader>
            <form id="delete-household-form" className="grid gap-4" noValidate onSubmit={deletionForm.handleSubmit(permanentlyDelete)}>
              <div>
                <label htmlFor="delete-current-pin" className="text-sm font-semibold">Current six-digit PIN</label>
                <Input id="delete-current-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} disabled={deletion.isPending} aria-invalid={Boolean(deletionForm.formState.errors.currentPin)} aria-describedby="delete-current-pin-error" className="mt-2 font-mono tracking-[0.3em]" {...deletionForm.register("currentPin")} />
                <p id="delete-current-pin-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{deletionForm.formState.errors.currentPin?.message}</p>
              </div>
              <div>
                <label htmlFor="delete-confirmation" className="text-sm font-semibold">Type DELETE to confirm</label>
                <Input id="delete-confirmation" autoComplete="off" spellCheck={false} disabled={deletion.isPending} aria-invalid={Boolean(deletionForm.formState.errors.confirmation)} aria-describedby="delete-confirmation-error" className="mt-2 font-mono" {...deletionForm.register("confirmation")} />
                <p id="delete-confirmation-error" className="mt-1.5 min-h-5 text-sm font-medium text-destructive" role="alert">{deletionForm.formState.errors.confirmation?.message}</p>
              </div>
              <p className="min-h-5 text-sm font-medium text-destructive" role="alert" aria-live="assertive">{deletionError}</p>
            </form>
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="outline" disabled={deletion.isPending}>Cancel</Button></DialogClose>
              <Button type="submit" form="delete-household-form" variant="destructive" disabled={deletion.isPending}>{deletion.isPending ? "Deleting Household…" : "Permanently delete Household"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}
