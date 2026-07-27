import { useEffect, useMemo, useState } from "react";

export type SelectableEpisode = {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string;
};

type Selection = { season: number | null; episodeId: string };

export function initialEpisodeSelection(episodes: SelectableEpisode[], initialEpisodeId?: string): Selection {
  const selected = initialEpisodeId
    ? episodes.find((episode) => episode.id === initialEpisodeId)
    : episodes.find((episode) => episode.season === 1 && episode.episode === 1);
  return selected ? { season: selected.season, episodeId: selected.id } : { season: null, episodeId: "" };
}

export function EpisodeSelector({
  episodes,
  programmeTitle,
  disabled = false,
  initialEpisodeId,
  legend = "Choose starting Show Progress",
  helpText,
  onSelectionChange,
}: {
  episodes: SelectableEpisode[];
  programmeTitle: string;
  disabled?: boolean;
  initialEpisodeId?: string;
  legend?: string;
  helpText?: string;
  onSelectionChange: (episodeId: string | null) => void;
}) {
  const initial = useMemo(() => initialEpisodeSelection(episodes, initialEpisodeId), [episodes, initialEpisodeId]);
  const [season, setSeason] = useState<number | null>(initial.season);
  const [episodeId, setEpisodeId] = useState(initial.episodeId);
  const seasons = useMemo(() => [...new Set(episodes.map((episode) => episode.season))].sort((a, b) => a - b), [episodes]);
  const seasonEpisodes = season === null ? [] : episodes.filter((episode) => episode.season === season);

  useEffect(() => {
    setSeason(initial.season);
    setEpisodeId(initial.episodeId);
    onSelectionChange(initial.episodeId || null);
  }, [initial, onSelectionChange]);

  return <fieldset className="episode-selector" disabled={disabled}>
    <legend>{legend}</legend>
    <p id="starting-episode-help">{helpText ?? `Choose a season, then a released regular episode for ${programmeTitle}.`}</p>
    <div className="episode-selector-fields">
      <div>
        <label htmlFor="starting-season">Season</label>
        <select
          id="starting-season"
          value={season ?? ""}
          aria-describedby="starting-episode-help"
          onChange={(event) => {
            const nextSeason = event.target.value ? Number(event.target.value) : null;
            setSeason(nextSeason);
            setEpisodeId("");
            onSelectionChange(null);
          }}
        >
          <option value="">Choose a season</option>
          {seasons.map((number) => <option key={number} value={number}>Season {number}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="starting-episode">Episode</label>
        <select
          id="starting-episode"
          value={episodeId}
          disabled={disabled || season === null}
          aria-describedby="starting-episode-help"
          onChange={(event) => {
            setEpisodeId(event.target.value);
            onSelectionChange(event.target.value || null);
          }}
        >
          <option value="">Choose an episode</option>
          {seasonEpisodes.map((episode) => <option key={episode.id} value={episode.id}>
            {episodeLabel(episode)}
          </option>)}
        </select>
      </div>
    </div>
  </fieldset>;
}

function episodeLabel(episode: SelectableEpisode) {
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(episode.released));
  return `E${String(episode.episode).padStart(2, "0")} — ${episode.title} — ${date}`;
}
