# Model multiple named Channels within a Household

A Household will contain multiple ID-backed, named Channels with a permanent TV or Movie type and independent Channel-owned playback state. Approved programmes remain Household-wide but enter the Approved Library only through one or more explicit Channel Assignments; every new Household receives one TV and one Movie Default Channel, while existing state migrates intact into equivalent defaults so the change is invisible until a Parent creates another Channel.

Default Channels have no privileged lifecycle after provisioning: a Parent may rename or delete them like additional Channels. Channel names are display labels and need not be unique, while canonical Stremio Viewing Progress remains shared when Channels reach the same programme.

Each Household may configure at most five TV Channels and five Movie Channels. The per-type limit permits ten distinct viewing experiences while bounding each Household's catalog and state growth; combined with ADR 0010's five-programme window, TV preparation targets at most twenty-five scheduled positions.

The migration preserves the existing Default Channels' Stremio metadata identities and Parent Page links, as well as their playback state. Renaming a migrated Channel leaves that identity intact; deleting it retires the compatibility target rather than silently redirecting the old link to a different Channel.

Stremio's canonical stream request does not identify the Channel whose metadata initiated playback. Channel metadata therefore keeps canonical movie and episode video IDs for Viewing Progress and subtitle compatibility, but supplies a Channel-scoped inline first-party playback URL. That URL advances or defers only its source Channel before redirecting to the selected TorBox media. The legacy stream route remains mapped to the migrated Default Channel for installed-addon compatibility; Fire TV playback, autoplay, subtitles, and Viewing Progress remain a release-certification gate.
