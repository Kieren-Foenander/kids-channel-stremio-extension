import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

const torBoxSchema = z.object({
  token: z.string()
    .min(1, "Enter your TorBox API token.")
    .max(512, "The TorBox API token is too long.")
    .refine((value) => value === value.trim(), "Remove spaces before or after the token."),
});

type PinValues = z.infer<typeof pinSchema>;
type DeletionValues = z.infer<typeof deletionSchema>;
type TorBoxValues = z.infer<typeof torBoxSchema>;
type PinResponse = { message: string };
type TorBoxStatus = { configured: boolean; updatedAt: string | null; message?: string };

function SettingsPage() {
  const { secret } = Route.useParams();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [torBoxResult, setTorBoxResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
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
  const torBoxForm = useForm<TorBoxValues>({
    resolver: zodResolver(torBoxSchema),
    defaultValues: { token: "" },
  });
  const torBox = useQuery({
    queryKey: parentKeys.torBox(secret),
    queryFn: () => parentApi<TorBoxStatus>(`/api/households/${secret}/torbox`),
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
  const saveTorBox = useMutation({
    mutationFn: (values: TorBoxValues) => parentApi<TorBoxStatus>(`/api/households/${secret}/torbox`, {
      method: "PUT",
      body: values,
    }),
  });
  const clearTorBox = useMutation({
    mutationFn: () => parentApi<TorBoxStatus>(`/api/households/${secret}/torbox`, {
      method: "DELETE",
    }),
  });

  async function saveTorBoxToken(values: TorBoxValues) {
    if (saveTorBox.isPending || clearTorBox.isPending) return;
    setTorBoxResult(null);
    try {
      const response = await saveTorBox.mutateAsync(values);
      torBoxForm.reset();
      queryClient.setQueryData(parentKeys.torBox(secret), response);
      setTorBoxResult({ kind: "success", message: response.message || "TorBox connected." });
    } catch (error) {
      setTorBoxResult({ kind: "error", message: apiErrorMessage(error, "The TorBox token could not be saved. Try again.") });
    }
  }

  async function disconnectTorBox() {
    if (saveTorBox.isPending || clearTorBox.isPending) return;
    setTorBoxResult(null);
    try {
      const response = await clearTorBox.mutateAsync();
      torBoxForm.reset();
      queryClient.setQueryData(parentKeys.torBox(secret), response);
      setTorBoxResult({ kind: "success", message: response.message || "TorBox disconnected." });
    } catch (error) {
      setTorBoxResult({ kind: "error", message: apiErrorMessage(error, "TorBox could not be disconnected. Try again.") });
    }
  }

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
      queryClient.removeQueries({ queryKey: parentKeys.household(secret) });
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

  const torBoxStatusText = torBox.isPending
    ? "Checking connection…"
    : torBox.isError
      ? "TorBox connection status is unavailable."
      : torBox.data?.configured
        ? "TorBox is connected."
        : "TorBox is not connected.";

  return (
    <div className="grid gap-12">
      <PageHeader ident="Parent Page" title="Settings" description="Manage installation, streaming, and secure Parent access." />

      <section id="installation" className="scroll-mt-4" aria-labelledby="settings-installation-heading">
        <div className="mb-4">
          <h2 id="settings-installation-heading" className="text-xl font-semibold tracking-[-0.01em]">Install your Household addon</h2>
          <p className="mt-1 max-w-[46rem] text-sm leading-relaxed text-muted-foreground">Use the same private installation details on the Stremio account shared by your Household devices.</p>
        </div>
        <InstallationDetails secret={secret} />
      </section>

      <section className="grid gap-4 rounded-[4px] border bg-card p-5 md:grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)] md:gap-8" aria-labelledby="torbox-heading">
        <div>
          <h2 id="torbox-heading" className="text-xl font-semibold tracking-[-0.01em]">Connect TorBox</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Kids Channels uses your Household’s TorBox account to prepare or choose one playable stream for each programme.</p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">The token is validated before it is stored encrypted. It is never shown again after saving. Clearing it stops Channel playback until another valid token is saved.</p>
        </div>
        <div className="grid content-start gap-4">
          <p className="text-sm font-semibold" role="status">{torBoxStatusText}</p>
          <form className="grid gap-3" noValidate onSubmit={torBoxForm.handleSubmit(saveTorBoxToken)}>
            <div>
              <label htmlFor="torbox-token" className="text-sm font-semibold">TorBox API token</label>
              <Input
                id="torbox-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(torBoxForm.formState.errors.token)}
                aria-describedby="torbox-token-help torbox-token-error"
                className="mt-2 font-mono"
                {...torBoxForm.register("token")}
              />
              <p id="torbox-token-help" className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Paste the private API token from your TorBox account.</p>
              <p id="torbox-token-error" className="mt-1 min-h-5 text-sm font-medium text-destructive" role="alert">{torBoxForm.formState.errors.token?.message}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saveTorBox.isPending || clearTorBox.isPending}>
                {saveTorBox.isPending ? "Validating and saving…" : torBox.data?.configured ? "Replace token" : "Save token"}
              </Button>
              {torBox.data?.configured
                ? <Button type="button" variant="outline" disabled={saveTorBox.isPending || clearTorBox.isPending} onClick={disconnectTorBox}>{clearTorBox.isPending ? "Clearing…" : "Clear token"}</Button>
                : null}
            </div>
          </form>
          <p className={torBoxResult?.kind === "error" ? "min-h-5 text-sm font-medium text-destructive" : "min-h-5 text-sm font-medium text-accent"} role={torBoxResult?.kind === "error" ? "alert" : "status"} aria-live="polite">{torBoxResult?.message}</p>
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
