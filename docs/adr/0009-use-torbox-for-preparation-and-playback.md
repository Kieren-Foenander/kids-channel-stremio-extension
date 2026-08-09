# Use TorBox for preparation and playback

Kids Channels will use TorBox instead of Real-Debrid for first-party stream preparation and playback. Each Household supplies a TorBox API token through the authenticated Parent Page. The Worker validates it, encrypts it at rest, and never returns or logs it.

For every programme, the selector discovers and ranks torrent candidates, checks up to ten candidates with TorBox's cached-only create mode, and accepts a file only when it exactly matches the canonical episode. If no candidate is cached, a series request starts one normal TorBox download and stores that selection as pending. Preparation Runs revisit pending selections until ready, stalled, terminal, or expired. Movies remain cached-only so selecting a movie does not unexpectedly begin a large download.

Playback verifies that the stored TorBox torrent and file are still ready, requests a fresh TorBox download URL for the playback device's Cloudflare-observed IP, and redirects Stremio without proxying media bytes. Missing torrents or download links are discarded and the resolver tries another ranked hash inside the same request. Rate limits and other transient failures preserve the stored selection.

TorBox permits simultaneous use from multiple IP addresses and devices, so Preparation Runs may continue while the Household watches the Channel. TorBox plan limits, active download slots, and fair-use controls still apply. The Parent Page no longer presents the Real-Debrid idle-account warning or the experimental provider probe.

ADR 0010 replaces manual Preparation Run controls with automatic rolling warm-up while retaining the TorBox selection and playback decisions in this ADR.

Consequences:

- Existing Real-Debrid credentials remain only as unused historical database columns; the migration clears provider-specific stream selections and candidate failures.
- Active Preparation Runs are failed during migration because their stored torrent identifiers cannot be resolved through TorBox.
- TorBox credentials use new encrypted columns and replacing or clearing a credential invalidates local selections.
- Stremio receives only a Kids Channels resolve URL and then a short-lived TorBox CDN redirect; the TorBox API token is never embedded in addon metadata.
- ADR 0007 still governs first-party discovery, exact file matching, deterministic ranking, failover, and direct media handoff. ADR 0008 still governs time-bounded Cloudflare Workflow orchestration.
