import { useEffect, useMemo, useState } from "react";

export type SelectableEpisode = {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string;
};

type Selection = { season: number | null; episodeId: string };

export function initialEpisodeSelection(episodes: SelectableEpisode[]): Selection {
  const first = episodes.find((episode) => episode.season === 1 && episode.episode === 1);
  return first ? { season: 1, episodeId: first.id } : { season: null, episodeId: "" };
}

export function EpisodeSelector({
  episodes,
  programmeTitle,
  disabled = false,
  onSelectionChange,
}: {
  episodes: SelectableEpisode[];
  programmeTitle: string;
  disabled?: boolean;
  onSelectionChange: (episodeId: string | null) => void;
}) {
  const initial = useMemo(() => initialEpisodeSelection(episodes), [episodes]);
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
    <legend>Choose starting Show Progress</legend>
    <p id="starting-episode-help">Choose a season, then a released regular episode for {programmeTitle}.</p>
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
