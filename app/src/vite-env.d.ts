/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** MapTiler API key used to fetch the Outdoor v2 basemap style.
   *  Optional — the map falls back to MapLibre's public demo tiles
   *  when unset, so local dev and CI work without credentials. */
  readonly VITE_MAPTILER_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
