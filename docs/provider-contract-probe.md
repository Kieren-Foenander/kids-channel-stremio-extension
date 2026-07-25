# Optional stream-provider contract probe

This manual probe checks a developer-supplied configured Stremio provider endpoint. Comet is the recommended provider. The check is deliberately separate from deterministic tests and must not run in CI.

The manifest URL is a credential: do not paste it into an issue, commit it, put it on a command line, enable shell tracing, or retain terminal output from other tools. The probe prints only result counts and generic failures; it never prints request URLs, provider bodies, or stream URLs.

```bash
read -rsp 'Provider manifest URL: ' PROVIDER_MANIFEST_URL && echo
export PROVIDER_MANIFEST_URL
pnpm run probe:provider
unset PROVIDER_MANIFEST_URL
```

The probe checks the manifest and requests streams for the representative movie `tt0111161`. Success confirms only that the hosted interface is reachable and reports how many direct, cached Real-Debrid, and acceptable 1080p results were observed at that moment. It recognizes Comet's `[RD⚡]` marker and Torrentio's `RD+` marker. It does not replace a Fire TV playback check.
