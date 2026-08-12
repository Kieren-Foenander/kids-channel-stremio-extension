import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { CHANNEL_LIMIT_PER_TYPE, useChannels, type ChannelType, type ParentChannel } from "../lib/channels";
import { apiErrorMessage, parentApi, parentKeys } from "../lib/parent-api";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

export function ChannelCollectionControl({
  secret,
  type,
  selectedId,
  onSelect,
}: {
  secret: string;
  type: ChannelType;
  selectedId?: string;
  onSelect: (channelId: string) => void;
}) {
  const queryClient = useQueryClient();
  const channelsQuery = useChannels(secret, type);
  const channels = channelsQuery.data ?? [];
  const selected = channels.find((channel) => channel.id === selectedId) ?? channels[0];
  const [mode, setMode] = useState<"create" | "rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const deletionImpactQuery = useQuery({
    queryKey: parentKeys.channel(secret, selected?.id ?? ""),
    queryFn: () => parentApi<{
      deletionImpact: {
        assignments: Array<{ programmeId: string; title: string; type: "show" | "movie" }>;
        programmesLeavingHousehold: Array<{ programmeId: string; title: string; type: "show" | "movie" }>;
      };
    }>(`/api/households/${secret}/channels/${selected!.id}`),
    enabled: mode === "delete" && Boolean(selected),
    staleTime: 0,
  });

  // A missing or deleted selection falls back to the first Channel, including when the
  // Default Channel a link once pointed at has been deleted.
  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelect(selected.id);
  }, [onSelect, selected, selectedId]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: parentKeys.channels(secret) }),
      queryClient.invalidateQueries({ queryKey: parentKeys.overview(secret) }),
    ]);
    window.dispatchEvent(new Event("stremio-restart-required"));
  };

  const createMutation = useMutation({
    mutationFn: () => parentApi<{ channel: ParentChannel }>(`/api/households/${secret}/channels`, {
      method: "POST", body: { type, name },
    }),
    onSuccess: async ({ channel }) => {
      await refresh();
      onSelect(channel.id);
      setMode(null);
      setStatus(`${channel.name} created.`);
    },
  });
  const renameMutation = useMutation({
    mutationFn: () => parentApi<{ channel: ParentChannel }>(`/api/households/${secret}/channels/${selected!.id}`, {
      method: "PATCH", body: { name },
    }),
    onSuccess: async ({ channel }) => {
      await refresh();
      setMode(null);
      setStatus(`${channel.name} saved.`);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => parentApi<{ removedProgrammes: number }>(`/api/households/${secret}/channels/${selected!.id}`, {
      method: "DELETE",
    }),
    onSuccess: async ({ removedProgrammes }) => {
      const next = channels.find((channel) => channel.id !== selected?.id);
      await refresh();
      if (next) onSelect(next.id);
      setMode(null);
      setStatus(`Channel deleted${removedProgrammes ? `; ${removedProgrammes} unassigned programme${removedProgrammes === 1 ? "" : "s"} removed` : ""}.`);
    },
  });

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || name.trim().length > 40) return;
    if (mode === "create") createMutation.mutate();
    if (mode === "rename" && selected) renameMutation.mutate();
  }

  const nameMutation = mode === "create" ? createMutation : renameMutation;
  const label = type === "tv" ? "TV Channel" : "Movie Channel";
  return (
    <section className="grid gap-3 rounded-[4px] border bg-card p-4" aria-label={`${label} collection`}>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <label htmlFor={`${type}-channel-choice`} className="mb-1.5 block text-sm font-semibold">{label}</label>
          <NativeSelect
            id={`${type}-channel-choice`}
            value={selected?.id ?? ""}
            disabled={channelsQuery.isPending || channels.length === 0}
            onChange={(event) => onSelect(event.target.value)}
          >
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={channels.length >= CHANNEL_LIMIT_PER_TYPE} onClick={() => { setName(""); setMode("create"); }}>Create Channel</Button>
          <Button type="button" variant="outline" disabled={!selected} onClick={() => { setName(selected?.name ?? ""); setMode("rename"); }}>Rename</Button>
          <Button type="button" variant="outline" disabled={!selected} onClick={() => setMode("delete")}>Delete</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{channels.length}/{CHANNEL_LIMIT_PER_TYPE} {type === "tv" ? "TV" : "Movie"} Channels configured. Channels stay in creation order.</p>
      {channelsQuery.isError && <p className="text-sm text-destructive" role="alert">{apiErrorMessage(channelsQuery.error, "Channels could not be loaded.")}</p>}
      {status && <p className="text-sm font-medium text-accent" role="status">{status}</p>}

      <Dialog open={mode === "create" || mode === "rename"} onOpenChange={(open) => { if (!open && !nameMutation.isPending) setMode(null); }}>
        <DialogContent showCloseButton={!nameMutation.isPending}>
          <form onSubmit={submitName}>
            <DialogHeader>
              <DialogTitle>{mode === "create" ? `Create ${label}` : `Rename ${selected?.name ?? label}`}</DialogTitle>
              <DialogDescription>Names can repeat. This name identifies the Channel in the Parent Page and Stremio.</DialogDescription>
            </DialogHeader>
            <label htmlFor={`${type}-channel-name`} className="mt-5 block text-sm font-semibold">Channel name</label>
            <Input id={`${type}-channel-name`} className="mt-2" autoFocus minLength={1} maxLength={40} required value={name} onChange={(event) => setName(event.target.value)} />
            {nameMutation.isError && <p className="mt-3 text-sm text-destructive" role="alert">{apiErrorMessage(nameMutation.error, "The Channel could not be saved.")}</p>}
            <DialogFooter className="mt-5">
              <DialogClose asChild><Button type="button" variant="outline" disabled={nameMutation.isPending}>Cancel</Button></DialogClose>
              <Button type="submit" disabled={nameMutation.isPending || !name.trim() || name.trim().length > 40}>{nameMutation.isPending ? "Saving…" : "Save Channel"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "delete"} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) setMode(null); }}>
        <DialogContent showCloseButton={!deleteMutation.isPending}>
          <DialogHeader>
            <DialogTitle>Delete {selected?.name}?</DialogTitle>
            <DialogDescription>Its schedule, progress, and history will be removed. Programmes assigned nowhere else will also leave the Approved Library.</DialogDescription>
          </DialogHeader>
          {deletionImpactQuery.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">Loading affected programmes…</p>
          ) : deletionImpactQuery.isError ? (
            <p className="text-sm text-destructive" role="alert">The deletion impact could not be loaded. Try again before deleting this Channel.</p>
          ) : deletionImpactQuery.data.deletionImpact.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">This Channel has no Channel Assignments.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              <p>Deleting this Channel removes these Channel Assignments:</p>
              <ul className="grid gap-1" aria-label="Affected Channel Assignments">
                {deletionImpactQuery.data.deletionImpact.assignments.map((programme) => {
                  const leaves = deletionImpactQuery.data.deletionImpact.programmesLeavingHousehold
                    .some((candidate) => candidate.programmeId === programme.programmeId);
                  return <li key={programme.programmeId}><strong>{programme.title}</strong> — {leaves
                    ? "leaves the Approved Library"
                    : "remains assigned to another Channel"}</li>;
                })}
              </ul>
            </div>
          )}
          {deleteMutation.isError && <p className="text-sm text-destructive" role="alert">{apiErrorMessage(deleteMutation.error, "The Channel could not be deleted.")}</p>}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={deleteMutation.isPending}>Cancel</Button></DialogClose>
            <Button type="button" disabled={deleteMutation.isPending || !selected || !deletionImpactQuery.data} onClick={() => deleteMutation.mutate()}>{deleteMutation.isPending ? "Deleting…" : "Delete Channel"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
