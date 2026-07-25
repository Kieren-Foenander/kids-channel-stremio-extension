# Restart Stremio after Parent changes

Stremio retains an already-loaded addon metadata request in its in-memory resource model even when the Worker returns `Cache-Control: no-store`. Returning to the Channel or navigating elsewhere does not reliably force the identical metadata request to load again; fully closing and reopening Stremio does.

Approved Library changes and TV selection regeneration therefore update Worker and D1 Channel state immediately, while the Parent must restart Stremio before the client displays that state. Media already playing remains uninterrupted. After restart, removed or paused content is absent from the refreshed Channel and cannot be relaunched from its schedule.

This is an accepted MVP protocol limitation. Kids Channels cannot push cache invalidation into Stremio, and owning provider stream resolution to enforce server-side playback was rejected by ADR 0004 after IP-sensitive provider results failed with `Wrong IP`. The Parent Page must clearly instruct the Parent to restart Stremio after these changes.
