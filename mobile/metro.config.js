// Metro for the Aurora phone app. The app imports the shared domain model and filter engine
// straight from ../core (pure TypeScript, no DOM or Node APIs), so Metro watches that folder too.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../core')];
// Resolve packages only from the app's own node_modules, never from the server project.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
// Literata ships as WOFF2 (loaded on the web build; phones use their own serif until a TTF is bundled).
config.resolver.assetExts = [...config.resolver.assetExts, 'woff2'];

module.exports = config;
