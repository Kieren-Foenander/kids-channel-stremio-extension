import { useQuery } from "@tanstack/react-query";
import { parentApi, parentKeys } from "./parent-api";

export { CHANNEL_LIMIT_PER_TYPE } from "../channels";

export type ChannelType = "tv" | "movie";

export interface ParentChannel {
  id: string;
  householdId: string;
  type: ChannelType;
  name: string;
  legacyKey?: ChannelType;
  createdAt: string;
}

/** The Household's Channels are one list. Narrowing by type happens after the fetch so a
 * page showing both a Channel picker and its own Channel view shares a single request. */
export function useChannels(secret: string, type?: ChannelType) {
  return useQuery({
    queryKey: parentKeys.channels(secret),
    queryFn: () => parentApi<{ channels: ParentChannel[] }>(`/api/households/${secret}/channels`),
    select: ({ channels }) => type ? channels.filter((channel) => channel.type === type) : channels,
  });
}
