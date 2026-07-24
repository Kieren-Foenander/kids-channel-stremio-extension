const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '127.0.0.1';

const manifest = {
  id: 'community.kieren.stremio-extension',
  version: '0.1.0',
  name: 'Kieren Stremio Addon',
  description: 'Starter Stremio addon ready to customise.',
  logo: 'https://www.stremio.com/website/stremio-logo-small.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'starter-movies',
      name: 'Starter Movies'
    },
    {
      type: 'series',
      id: 'starter-series',
      name: 'Starter Series'
    }
  ],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(({ type, id }) => {
  console.log(`Catalog request: ${type}/${id}`);

  return Promise.resolve({ metas: [] });
});

builder.defineMetaHandler(({ type, id }) => {
  console.log(`Meta request: ${type}/${id}`);

  return Promise.resolve({ meta: null });
});

builder.defineStreamHandler(({ type, id }) => {
  console.log(`Stream request: ${type}/${id}`);

  return Promise.resolve({ streams: [] });
});

serveHTTP(builder.getInterface(), { port: PORT, host: HOST });

console.log(`Stremio addon running at http://${HOST}:${PORT}/manifest.json`);
