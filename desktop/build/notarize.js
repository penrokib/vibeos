// =============================================================================
// rokibrain.app — afterSign hook: Apple notarisation via @electron/notarize
// -----------------------------------------------------------------------------
// Owner: M13 build-pipeline.
// Spec: state/rokibrain-app-v1-design-2026-05-07.md §6
//
// Behaviour:
//   - In CI with all 3 env vars present, calls notarytool via @electron/notarize.
//   - In local dev (any env var missing), logs a warning and returns cleanly,
//     so `yarn dist:mac` still produces an unsigned-and-not-notarised DMG
//     suitable for QA. This matches the dispatch acceptance gate:
//       "yarn workspace @vibeos/desktop dist:mac produces an unsigned DMG
//        without errors when run without APPLE_* env (warns + skips notarize)."
//   - Only runs on macOS (`darwin` electronPlatformName); other OSes are no-op.
//
// Required env vars (CI only):
//   APPLE_ID                    — Apple ID email used for notarytool.
//   APPLE_APP_SPECIFIC_PASSWORD — app-specific password (NOT the AppleID pw).
//   APPLE_TEAM_ID               — 10-char Apple Developer Team ID.
//
// HARDWALL: this file MUST NOT log secret values. Only existence checks.
// =============================================================================

'use strict';

const path = require('node:path');

/**
 * @param {{electronPlatformName: string, appOutDir: string, packager: {appInfo: {productFilename: string}}}} context
 */
module.exports = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return; // Linux / Windows builds skip silently.
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  // Local-dev / unsigned path — skip with a clear warning.
  if (!appleId || !appleIdPassword || !teamId) {
    const missing = [
      !appleId && 'APPLE_ID',
      !appleIdPassword && 'APPLE_APP_SPECIFIC_PASSWORD',
      !teamId && 'APPLE_TEAM_ID',
    ]
      .filter(Boolean)
      .join(', ');
    // eslint-disable-next-line no-console
    console.warn(
      `[notarize] Skipping notarisation — missing env: ${missing}. ` +
        'Result will be an unsigned DMG (QA-only, NOT shippable to users).',
    );
    return;
  }

  // Lazy-require so local dev `yarn install` does not need @electron/notarize
  // until it is actually used (CI installs it via devDependency).
  let notarizeFn;
  try {
    // eslint-disable-next-line global-require
    ({ notarize: notarizeFn } = require('@electron/notarize'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[notarize] @electron/notarize is not installed. ' +
        'Install it as a devDependency to enable notarisation. Skipping.',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // eslint-disable-next-line no-console
  console.log(`[notarize] Submitting ${appPath} to Apple notarytool…`);

  await notarizeFn({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  // eslint-disable-next-line no-console
  console.log('[notarize] Notarisation succeeded for', appPath);
};
