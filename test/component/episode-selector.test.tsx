import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpisodeSelector, type SelectableEpisode } from "../../src/components/EpisodeSelector";

const episodes: SelectableEpisode[] = [
  { id: "show:1:1", season: 1, episode: 1, title: "First", released: "2020-01-01T00:00:00.000Z" },
  { id: "show:1:2", season: 1, episode: 2, title: "Second", released: "2020-01-08T00:00:00.000Z" },
  { id: "show:2:1", season: 2, episode: 1, title: "A new start", released: "2021-02-03T00:00:00.000Z" },
];

afterEach(cleanup);

describe("EpisodeSelector", () => {
  it("defaults to S01E01 when that released episode is available", () => {
    const onSelectionChange = vi.fn();
    render(<EpisodeSelector episodes={episodes} programmeTitle="The Example" onSelectionChange={onSelectionChange} />);

    expect(screen.getByLabelText("Season")).toHaveValue("1");
    expect(screen.getByLabelText("Episode")).toHaveValue("show:1:1");
    expect(screen.getByRole("option", { name: "E01 — First — 1 Jan 2020" })).toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenLastCalledWith("show:1:1");
  });

  it("starts at the supplied current Show Progress for correction", () => {
    const onSelectionChange = vi.fn();
    render(<EpisodeSelector
      episodes={episodes}
      programmeTitle="The Example"
      initialEpisodeId="show:2:1"
      legend="Choose corrected Show Progress"
      onSelectionChange={onSelectionChange}
    />);

    expect(screen.getByRole("group", { name: "Choose corrected Show Progress" })).toBeInTheDocument();
    expect(screen.getByLabelText("Season")).toHaveValue("2");
    expect(screen.getByLabelText("Episode")).toHaveValue("show:2:1");
    expect(onSelectionChange).toHaveBeenLastCalledWith("show:2:1");
  });

  it("requires an explicit choice without S01E01 and resets the episode when season changes", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(<EpisodeSelector episodes={episodes.slice(1)} programmeTitle="The Example" onSelectionChange={onSelectionChange} />);

    const season = screen.getByLabelText("Season");
    const episode = screen.getByLabelText("Episode");
    expect(season).toHaveValue("");
    expect(episode).toBeDisabled();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);

    await user.selectOptions(season, "2");
    expect(episode).toBeEnabled();
    expect(screen.getByRole("option", { name: "E01 — A new start — 3 Feb 2021" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Second/ })).not.toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);

    await user.selectOptions(episode, "show:2:1");
    expect(onSelectionChange).toHaveBeenLastCalledWith("show:2:1");
    await user.selectOptions(season, "1");
    expect(episode).toHaveValue("");
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });
});
