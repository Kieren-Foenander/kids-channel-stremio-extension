import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../components/Button";
import { InstallationDetails } from "../components/InstallationDetails";
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
    <div className="settings-page">
      <header className="destination-header">
        <p className="eyebrow">Parent Page</p>
        <h1>Settings</h1>
        <p>Revisit installation details and manage secure Parent access.</p>
      </header>

      <section id="installation" className="settings-section" aria-labelledby="settings-installation-heading">
        <div className="settings-heading">
          <p className="eyebrow">Installation</p>
          <h2 id="settings-installation-heading">Install your Household addon</h2>
          <p>Use the same private installation details on the Stremio account shared by your Household devices.</p>
        </div>
        <InstallationDetails secret={secret} />
      </section>

      <section className="card settings-section stream-guidance" aria-labelledby="stream-addon-heading">
        <div>
          <p className="eyebrow">Playback</p>
          <h2 id="stream-addon-heading">Configure a separate stream addon</h2>
        </div>
        <div>
          <p>Kids Channels schedules programmes but does not provide or inspect streams. Install and configure a stream addon such as Comet separately in Stremio.</p>
          <p>For the simplest source choice, prefer cached 1080p results and keep the number of returned results low. Stream availability and source selection remain inside Stremio.</p>
        </div>
      </section>

      <section className="card settings-section parent-access" aria-labelledby="parent-access-heading">
        <div className="settings-heading">
          <p className="eyebrow">Security</p>
          <h2 id="parent-access-heading">Parent access</h2>
          <p>There is no forgotten-PIN or Household recovery. Changing the PIN signs out every previous Parent session while keeping this browser signed in.</p>
          <p>To end this browser's access immediately, use <strong>Lock Parent Page</strong> in the navigation.</p>
        </div>
        <form className="form pin-form" noValidate onSubmit={form.handleSubmit(changePin)}>
          <div>
            <label htmlFor="current-pin">Current PIN</label>
            <input id="current-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} aria-invalid={Boolean(form.formState.errors.currentPin)} aria-describedby="current-pin-error" {...form.register("currentPin")} />
            <p id="current-pin-error" className="field-error" role="alert">{form.formState.errors.currentPin?.message}</p>
          </div>
          <div>
            <label htmlFor="new-pin">New six-digit PIN</label>
            <input id="new-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} aria-invalid={Boolean(form.formState.errors.newPin)} aria-describedby="new-pin-error" {...form.register("newPin")} />
            <p id="new-pin-error" className="field-error" role="alert">{form.formState.errors.newPin?.message}</p>
          </div>
          <Button type="submit" disabled={rotation.isPending}>{rotation.isPending ? "Changing PIN…" : "Change Parent PIN"}</Button>
          <p id="pin-status" className={result?.kind === "error" ? "field-error pin-result" : "action-status pin-result"} role={result?.kind === "error" ? "alert" : "status"} aria-live="polite">{result?.message}</p>
        </form>
      </section>

      <section className="settings-section danger-zone" aria-labelledby="danger-zone-heading">
        <div className="settings-heading">
          <p className="eyebrow">Danger zone</p>
          <h2 id="danger-zone-heading">Permanently delete Household</h2>
          <p>Deletion removes the Approved Library, Show Progress, Channel Schedules, Current Programmes, playback history, PIN, Parent sessions, and synced addon access. It cannot be undone.</p>
        </div>
        <Dialog open={deletionOpen} onOpenChange={setDeletionDialog}>
          <DialogTrigger asChild><Button type="button" variant="destructive">Delete Household…</Button></DialogTrigger>
          <DialogContent className="deletion-dialog" showCloseButton={!deletion.isPending} onEscapeKeyDown={(event) => deletion.isPending && event.preventDefault()} onPointerDownOutside={(event) => deletion.isPending && event.preventDefault()}>
            <DialogHeader>
              <DialogTitle>Delete Household permanently?</DialogTitle>
              <DialogDescription>This removes every programme and all Channel state. Stremio and every Parent session will immediately lose access. This action cannot be undone.</DialogDescription>
            </DialogHeader>
            <form id="delete-household-form" className="form deletion-form" noValidate onSubmit={deletionForm.handleSubmit(permanentlyDelete)}>
              <div>
                <label htmlFor="delete-current-pin">Current six-digit PIN</label>
                <input id="delete-current-pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} disabled={deletion.isPending} aria-invalid={Boolean(deletionForm.formState.errors.currentPin)} aria-describedby="delete-current-pin-error" {...deletionForm.register("currentPin")} />
                <p id="delete-current-pin-error" className="field-error" role="alert">{deletionForm.formState.errors.currentPin?.message}</p>
              </div>
              <div>
                <label htmlFor="delete-confirmation">Type DELETE to confirm</label>
                <input id="delete-confirmation" autoComplete="off" spellCheck={false} disabled={deletion.isPending} aria-invalid={Boolean(deletionForm.formState.errors.confirmation)} aria-describedby="delete-confirmation-error" {...deletionForm.register("confirmation")} />
                <p id="delete-confirmation-error" className="field-error" role="alert">{deletionForm.formState.errors.confirmation?.message}</p>
              </div>
              <p className="field-error deletion-result" role="alert" aria-live="assertive">{deletionError}</p>
            </form>
            <DialogFooter>
              <DialogClose asChild><Button type="button" className="button-secondary" disabled={deletion.isPending}>Cancel</Button></DialogClose>
              <Button type="submit" form="delete-household-form" variant="destructive" disabled={deletion.isPending}>{deletion.isPending ? "Deleting Household…" : "Permanently delete Household"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </div>
  );
}
