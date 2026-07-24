const manifestValue = process.env.TORRENTIO_MANIFEST_URL;
if (!manifestValue) {
  console.error("Set TORRENTIO_MANIFEST_URL to a configured HTTPS manifest URL.");
  process.exitCode = 2;
} else {
  try {
    const manifestUrl = new URL(manifestValue);
    if (manifestUrl.protocol !== "https:" || !manifestUrl.pathname.endsWith("/manifest.json")) throw new Error();

    const manifestResponse = await fetch(manifestUrl, { headers: { accept: "application/json" } });
    const manifest = await manifestResponse.json();
    if (!manifestResponse.ok || typeof manifest.id !== "string" || !Array.isArray(manifest.resources)) throw new Error();

    const streamUrl = new URL(manifestUrl);
    streamUrl.pathname = `${streamUrl.pathname.slice(0, -"manifest.json".length)}stream/movie/tt0111161.json`;
    const streamResponse = await fetch(streamUrl, { headers: { accept: "application/json" } });
    const body = await streamResponse.json();
    if (!streamResponse.ok || !Array.isArray(body.streams)) throw new Error();

    const cached = body.streams.filter((stream) => {
      const label = `${stream?.name ?? ""}\n${stream?.title ?? ""}`;
      return typeof stream?.url === "string" && /(?:^|\s|\n)RD\+(?:\s|$)/i.test(label) && !/download/i.test(label);
    });
    const acceptable = cached.filter((stream) => /\b1080p?\b/i.test(`${stream?.name ?? ""}\n${stream?.title ?? ""}`));
    console.log(`Probe succeeded: manifest valid; cached direct results=${cached.length}; acceptable 1080p results=${acceptable.length}.`);
  } catch {
    console.error("Probe failed: the manifest or representative stream request was not usable.");
    process.exitCode = 1;
  }
}
