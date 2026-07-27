import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../components/Button";
import { InstallationDetails } from "../components/InstallationDetails";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";

export const Route = createFileRoute("/households/$secret/settings")({ component: SettingsPage });

const pinSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/, "Enter your current six-digit PIN."),
  newPin: z.string().regex(/^\d{6}$/, "Enter a new six-digit PIN."),
}).superRefine((values, context) => {
  if (/^\d{6}$/.test(values.currentPin) && values.currentPin === values.newPin) {
    context.addIssue({ code: "custom", path: ["newPin"], message: "Choose a new PIN that differs from the current PIN." });
  }
});

type PinValues = z.infer<typeof pinSchema>;
type PinResponse = { message: string };

function SettingsPage() {
  const { secret } = Route.useParams();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const form = useForm<PinValues>({
    resolver: zodResolver(pinSchema),
    defaultValues: { currentPin: "", newPin: "" },
  });
  const rotation = useMutation({
    mutationFn: (values: PinValues) => parentApi<PinResponse>(`/api/households/${secret}/pin`, {
      method: "PUT",
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
    </div>
  );
}
