// Android share target, without a new native module.
//
// app.json adds an ACTION_SEND intent filter for text/plain, so Aurora shows up in the share sheet.
// A shared link arrives as an intent extra (EXTRA_TEXT), which React Native's Linking cannot see.
// This config plugin adds a few lines to the generated MainActivity that turn such an intent into
// an ordinary deep link, aurora://follow?text=<shared text>, before React Native reads it. The app
// then opens the agent box with "Follow this: <link>" filled in (app/follow.tsx). Nothing is sent
// until the user presses Send.
//
// Applied at prebuild (npx expo prebuild, or an EAS build). Expo Go cannot use it.
const { withMainActivity } = require('expo/config-plugins');

const MARK = '// Aurora share target';

const HELPER = `
  ${MARK} (plugins/withShareTarget.js): a link shared from another app arrives as ACTION_SEND
  // with the text in EXTRA_TEXT. Hand it on as aurora://follow?text=... so the app's router opens
  // the agent box with the link filled in. Nothing is sent from here.
  private fun auroraShareToLink(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    if (intent.type?.startsWith("text/") != true) return
    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
    intent.action = Intent.ACTION_VIEW
    intent.data = Uri.parse("aurora://follow?text=" + Uri.encode(text.take(4000)))
  }
`;

const NEW_INTENT = `
  override fun onNewIntent(intent: Intent) {
    auroraShareToLink(intent)
    super.onNewIntent(intent)
  }
`;

/** Adds the share hook to MainActivity.kt source. Returns the source unchanged if already added. */
function addShareHook(src) {
  if (src.includes(MARK)) return src;
  let out = src;
  for (const imp of ['android.content.Intent', 'android.net.Uri']) {
    if (!new RegExp(`^import ${imp.replace(/\./g, '\\.')}$`, 'm').test(out)) out = out.replace(/^(package [^\n]+\n)/m, `$1\nimport ${imp}`);
  }
  if (!/super\.onCreate\(/.test(out)) throw new Error('withShareTarget: MainActivity has no onCreate to hook');
  out = out.replace(/(\n(\s*)super\.onCreate\()/, '\n$2auroraShareToLink(intent)$1');
  if (/override fun onNewIntent\(/.test(out)) {
    out = out.replace(/(override fun onNewIntent\(\s*(\w+)\s*:\s*Intent\??\s*\)\s*\{)/, '$1\n    auroraShareToLink($2)');
  } else {
    out = out.replace(/\}\s*$/, `${NEW_INTENT}}\n`);
  }
  return out.replace(/\}\s*$/, `${HELPER}}\n`);
}

function withShareTarget(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') throw new Error('withShareTarget: expected a Kotlin MainActivity');
    cfg.modResults.contents = addShareHook(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withShareTarget;
module.exports.addShareHook = addShareHook;
