# Optional Torrentio contract probe

This manual probe checks the current hosted Torrentio contract with a developer-supplied configured endpoint. It is deliberately separate from deterministic tests and must not run in CI.

The manifest URL is a credential: do not paste it into an issue, commit it, put it on a command line, enable shell tracing, or retain terminal output from other tools. The probe prints only result counts and generic failures; it never prints request URLs, provider bodies, or stream URLs.

```bash
read -rsp 'Torrentio manifest URL: ' TORRENTIO_MANIFEST_URL && echo
export TORRENTIO_MANIFEST_URL
pnpm probe:torrentio
unset TORRENTIO_MANIFEST_URL
```

The probe checks the manifest and requests streams for the representative movie `tt0111161`. Success confirms only that the hosted interface is reachable and reports how many cached direct and acceptable 1080p results were observed at that moment. It does not replace a Fire TV playback check.
