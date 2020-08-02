/**
 * @module util-entitlements
 */

'use strict'

const { promises: fs } = require('fs')
const os = require('os')
const path = require('path')
const plist = require('plist')

const { debuglog, getAppContentsPath } = require('./util')

async function createTemporaryEntitlementsFile (opts, entitlements) {
  const tmpEntitlementsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'electron-osx-sign-entitlements-'))
  opts.entitlements = path.join(tmpEntitlementsDir, 'entitlements.plist')

  await fs.writeFile(opts.entitlements, plist.build(entitlements), 'utf8')
  debuglog('Entitlements file updated:', '\n',
    '> Entitlements:', opts.entitlements)
}

function setDefaultEntitlementValue (entitlements, keySuffix, defaultValue) {
  const key = `com.apple.${keySuffix}`
  if (entitlements[key]) {
    debuglog(`'${key}' found in entitlements file`, entitlements[key])
  } else {
    debuglog(`'${key}' not found in entitlements file, setting to:`, defaultValue)
    entitlements[key] = defaultValue
  }
}

/**
 * This function returns a promise completing the entitlements automation: The process includes checking in `Info.plist` for `ElectronTeamID` or setting parsed value from identity, and checking in entitlements file for `com.apple.security.application-groups` or inserting new into array. A temporary entitlements file may be created to replace the input for any changes introduced.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.preAutoEntitlements = async function (opts) {
  // If entitlements file not provided, default will be used. Fixes #41
  const appInfoPath = path.join(getAppContentsPath(opts), 'Info.plist')

  debuglog('Automating entitlement app group...', '\n',
    '> Info.plist:', appInfoPath, '\n',
    '> Entitlements:', opts.entitlements)
  const entitlements = plist.parse(await fs.readFile(opts.entitlements, 'utf8'))
  if (!entitlements['com.apple.security.app-sandbox']) {
    // Only automate when app sandbox enabled by user
    return
  }

  const appInfo = plist.parse(await fs.readFile(appInfoPath, 'utf8'))
  // Use ElectronTeamID in Info.plist if already specified
  if (appInfo.ElectronTeamID) {
    debuglog('`ElectronTeamID` found in `Info.plist`', appInfo.ElectronTeamID)
  } else {
    // The team identifier in signing identity should not be trusted
    if (opts['provisioning-profile']) {
      appInfo.ElectronTeamID = opts['provisioning-profile'].message.Entitlements['com.apple.developer.team-identifier']
      debuglog('`ElectronTeamID` not found in `Info.plist`, use parsed from provisioning profile', appInfo.ElectronTeamID)
    } else {
      appInfo.ElectronTeamID = opts.identity.name.substring(opts.identity.name.indexOf('(') + 1, opts.identity.name.lastIndexOf(')'))
      debuglog('`ElectronTeamID` not found in `Info.plist`, use parsed from signing identity', appInfo.ElectronTeamID)
    }
    await fs.writeFile(appInfoPath, plist.build(appInfo), 'utf8')
    debuglog('`Info.plist` updated:', '\n',
      '> Info.plist:', appInfoPath)
  }

  const appIdentifier = `${appInfo.ElectronTeamID}.${appInfo.CFBundleIdentifier}`
  setDefaultEntitlementValue(entitlements, 'application-identifier', appIdentifier)
  setDefaultEntitlementValue(entitlements, 'developer.team-identifier', appInfo.ElectronTeamID)

  // Init entitlements app group key to array if not exists
  if (!entitlements['com.apple.security.application-groups']) {
    entitlements['com.apple.security.application-groups'] = []
  }
  // Insert app group if not exists
  if (Array.isArray(entitlements['com.apple.security.application-groups']) && !entitlements['com.apple.security.application-groups'].includes(appIdentifier)) {
    debuglog('`com.apple.security.application-groups` not found in entitlements file, new inserted:', appIdentifier)
    entitlements['com.apple.security.application-groups'].push(appIdentifier)
  } else {
    debuglog('`com.apple.security.application-groups` found in entitlements file:', appIdentifier)
  }

  await createTemporaryEntitlementsFile(opts, entitlements)
}
