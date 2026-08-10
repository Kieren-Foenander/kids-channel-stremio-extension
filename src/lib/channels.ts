import { useQuery } from "@tanstack/react-query";
import { parentApi, parentKeys } from "./parent-api";

export type ChannelType = "tv" | "movie";

export interface ParentChannel {
  id: string;
  householdId: string;
  type: ChannelType;
  name: string;
  legacyKey?: ChannelType;
  createdAt: string;
}

export function useChannels(secret: string, type?: ChannelType) {
  return useQuery({
    queryKey: parentKeys.channels(secret, type),
    queryFn: async () => {
      const response = await parentApi<{ channels: ParentChannel[] }>(`/api/households/${secret}/channels`);
      return type ? response.channels.filter((channel) => channel.type === type) : response.channels;
    },
  });
}
