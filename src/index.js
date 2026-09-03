/**
 * Programmatic entry point.
 *
 * Everything the CLI does is available here too, so Melora can be embedded in
 * a larger script — a backup routine, a NAS job, a launchd agent — without
 * shelling out.
 */
export { loadConfig, saveConfig, updateConfig, configPath, configHome } from './config.js';
export { Library } from './library.js';
export { openDatabase, databasePath, cacheDir, trashDir } from './db.js';
export { scanLibrary, verifyLibrary, pruneMissing } from './scanner.js';
export { syncSources, normaliseSource } from './sync.js';
export { createServer, startServer } from './server.js';
export { cacheStats, clearCache, ensureArt, SIZES } from './art.js';
export {
  listPlaylistFiles,
  playlistRelPath,
  readPlaylistFile,
  writePlaylistFile,
} from './playlists.js';
export {
  initLibrary,
  discoverLibrary,
  locateLibrary,
  readMarker,
  writeMarker,
  mountRoots,
  VolumeWatcher,
  MARKER_FILENAME,
  INTERNAL_DIRNAME,
  PLAYLIST_DIRNAME,
} from './volume.js';
