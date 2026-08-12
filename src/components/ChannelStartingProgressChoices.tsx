import { useCallback } from "react";
import { EpisodeSelector, type SelectableEpisode } from "./EpisodeSelector";

export function ChannelStartingProgressChoices({
  channels,
  episodes,
  programmeTitle,
  selectedEpisodeIds,
  disabled = false,
  onSelectionChange,
}: {
  channels: Array<{ id: string; name: string }>;
  episodes: SelectableEpisode[];
  programmeTitle: string;
  selectedEpisodeIds: Record<string, string>;
  disabled?: boolean;
  onSelectionChange: (channelId: string, episodeId: string | null) => void;
}) {
  return <div className="grid gap-3">
    {channels.map((channel) => <ChannelStartingProgressChoice
      key={channel.id}
      channel={channel}
      episodes={episodes}
      programmeTitle={programmeTitle}
      initialEpisodeId={selectedEpisodeIds[channel.id]}
      disabled={disabled}
      onSelectionChange={onSelectionChange}
    />)}
  </div>;
}

function ChannelStartingProgressChoice({
  channel,
  episodes,
  programmeTitle,
  initialEpisodeId,
  disabled,
  onSelectionChange,
}: {
  channel: { id: string; name: string };
  episodes: SelectableEpisode[];
  programmeTitle: string;
  initialEpisodeId?: string;
  disabled: boolean;
  onSelectionChange: (channelId: string, episodeId: string | null) => void;
}) {
  const selectEpisode = useCallback((episodeId: string | null) => {
    onSelectionChange(channel.id, episodeId);
  }, [channel.id, onSelectionChange]);

  return <EpisodeSelector
    episodes={episodes}
    programmeTitle={programmeTitle}
    initialEpisodeId={initialEpisodeId}
    idPrefix={`starting-${channel.id}`}
    legend={`Starting Show Progress for ${channel.name}`}
    disabled={disabled}
    onSelectionChange={selectEpisode}
  />;
}
