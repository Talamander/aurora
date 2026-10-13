// Runs before `npm start`, `npm run dev` and `npm test`: Aurora is TypeScript run by Node's own
// type stripping and stores everything in node:sqlite, so an older Node fails with a confusing
// "Unknown file extension .ts". Say what is wrong instead. Kept to old syntax on purpose.
var parts = process.versions.node.split('.').map(Number);
var major = parts[0];
var minor = parts[1];
var ok = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
if (!ok) {
  console.error('');
  console.error('Aurora needs Node.js 22.18 or newer (24 or newer recommended). This is Node ' + process.versions.node + '.');
  console.error('  macOS:  brew install node     (then open a new terminal)');
  console.error('  Linux:  install Node 24+ from your package manager, nodejs.org or nvm');
  console.error('');
  process.exit(1);
}
