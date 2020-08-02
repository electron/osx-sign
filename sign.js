/**
 * @module sign
 */

'use strict'

const compareVersion = require('compare-version')
const path = require('path')

const pkg = require('./package.json')
const { debuglog, debugwarn, getAppContentsPath, execFileAsync, pathsToSignAsync, validateOptsAppAsync, validateOptsPlatformAsync } = require('./util')
const { determineIdentityForSigning, findIdentitiesAsync, Identity } = require('./util-identities')
const { preAutoEntitlements } = require('./util-entitlements')
const { preEmbedProvisioningProfile, ProvisioningProfile } = require('./util-provisioning-profiles')

const osRelease = require('os').release()

/**
 * Validates opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 * @function
 * @param {Object} opts - Options.
 */
function validateOptsBinaries (opts) {
  if (opts.binaries) {
    if (!Array.isArray(opts.binaries)) {
      throw new Error('Additional binaries should be an Array.')
    }
    // TODO: Presence check for binary files, reject if any does not exist
  }
}

/**
 * This function returns a promise validating all options passed in opts.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
async function validateSignOptsAsync (opts) {
  if (opts.ignore && !(opts.ignore instanceof Array)) {
    opts.ignore = [opts.ignore]
  }

  if (opts['provisioning-profile'] && typeof opts['provisioning-profile'] !== 'string' && !(opts['provisioning-profile'] instanceof ProvisioningProfile)) {
    throw new Error('Path to provisioning profile should be a string or a ProvisioningProfile object.')
  }

  if (opts.type) {
    if (opts.type !== 'development' && opts.type !== 'distribution') {
      throw new Error('Type must be either `development` or `distribution`.')
    }
  } else {
    opts.type = 'distribution'
  }

  await validateOptsAppAsync(opts)
  await validateOptsPlatformAsync(opts)
  validateOptsBinaries(opts)
}

function strictVerifyArg (opts) {
  // Strict flag since darwin 15.0.0 --> OS X 10.11.0 El Capitan
  if (opts['strict-verify'] !== false && compareVersion(osRelease, '15.0.0') >= 0) {
    // strict-verify Array value should be converted to a comma-separated string
    return [opts['strict-verify'] ? `--strict=${opts['strict-verify']}` : '--strict']
  }

  return []
}

/**
 * This function returns a promise verifying the code sign of application bundle.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving output.
 */
async function verifySignApplicationAsync (opts) {
  debuglog('Verifying application bundle with codesign...')

  await execFileAsync('codesign', [
    '--verify',
    '--deep',
    ...strictVerifyArg(opts),
    '--verbose=2',
    opts.app
  ])

  // Additionally test Gatekeeper acceptance for darwin platform
  if (opts.platform === 'darwin' && opts['gatekeeper-assess'] !== false) {
    debuglog('Verifying Gatekeeper acceptance for darwin platform...')
    await execFileAsync('spctl', [
      '--assess',
      '--type', 'execute',
      '--verbose',
      '--ignore-cache',
      '--no-cache',
      opts.app
    ])
  }
}

function ignoreFilePath (opts, filePath) {
  if (opts.ignore) {
    return opts.ignore.some(function (ignore) {
      if (typeof ignore === 'function') {
        return ignore(filePath)
      }
      return filePath.match(ignore)
    })
  }
  return false
}

/**
 * Parse signature flags if it is given as a comma-delimited string.
 */
function parseSignatureFlags (signatureFlags) {
  if (Array.isArray(signatureFlags)) {
    return signatureFlags
  } else {
    return signatureFlags.split(',').map(flag => flag.trim())
  }
}

function determineEntitlementsFile (opts, filePath) {
  if (filePath.includes('Library/LoginItems')) {
    return opts['entitlements-loginhelper']
  } else {
    return opts['entitlements-inherit']
  }
}

/**
 * Generate the codesign args for signing a file and the app, depending on whether entitlements
 * were provided.
 */
function generateCodesignArgs (baseArgs, pathToSign, opts) {
  if (opts.entitlements) {
    return baseArgs.concat('--entitlements', determineEntitlementsFile(opts, pathToSign), pathToSign)
  } else {
    return baseArgs.concat(pathToSign)
  }
}

/**
 * This function returns a promise codesigning only.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
async function signApplicationAsync (opts) {
  let childPaths = await pathsToSignAsync(getAppContentsPath(opts))
  if (opts.binaries) {
    childPaths.push.apply(childPaths, opts.binaries)
  }

  const args = [
    '--sign', opts.identity.hash || opts.identity.name,
    '--force'
  ]
  if (opts.keychain) {
    args.push('--keychain', opts.keychain)
  }
  if (opts.requirements) {
    args.push('--requirements', opts.requirements)
  }
  if (opts.timestamp) {
    args.push('--timestamp=' + opts.timestamp)
  } else {
    args.push('--timestamp')
  }
  if (opts['signature-size']) {
    if (Number.isInteger(opts['signature-size']) && opts['signature-size'] > 0) {
      args.push('--signature-size', opts['signature-size'])
    } else {
      debugwarn(`Invalid value provided for --signature-size (${opts['signature-size']}). Must be a positive integer.`)
    }
  }

  let optionsArguments = []

  if (opts['signature-flags']) {
    optionsArguments.push.apply(optionsArguments, parseSignatureFlags(opts['signature-flags']))
  }

  if (opts.hardenedRuntime || opts['hardened-runtime'] || optionsArguments.includes('runtime')) {
    // Hardened runtime since darwin 17.7.0 --> macOS 10.13.6
    if (compareVersion(osRelease, '17.7.0') >= 0) {
      optionsArguments.push('runtime')
    } else {
      // Remove runtime if passed in with --signature-flags
      debuglog('Not enabling hardened runtime, current macOS version too low, requires 10.13.6 and higher')
      optionsArguments = optionsArguments.filter(function (element, index) { return element !== 'runtime' })
    }
  }

  if (opts.restrict) {
    optionsArguments.push('restrict')
    debugwarn('This flag is to be deprecated, consider using --signature-flags=restrict instead')
  }

  if (optionsArguments.length) {
    args.push('--options', [...new Set(optionsArguments)].join(','))
  }

  /**
   * Sort the child paths by how deep they are in the file tree.  Some arcane apple
   * logic expects the deeper files to be signed first otherwise strange errors get
   * thrown our way
   */
  childPaths = childPaths.sort((a, b) => {
    const aDepth = a.split(path.sep).length
    const bDepth = b.split(path.sep).length
    return bDepth - aDepth
  })

  for (const filePath of childPaths) {
    if (ignoreFilePath(opts, filePath)) {
      debuglog(`Skipped... ${filePath}`)
      return
    }

    debuglog(`Signing... ${filePath}`)
    await execFileAsync('codesign', generateCodesignArgs(args, filePath, opts))
  }

  debuglog(`Signing... ${opts.app}`)
  await execFileAsync('codesign', generateCodesignArgs(args, opts.app, opts))

  // Verify code sign
  debuglog('Verifying...')
  await verifySignApplicationAsync(opts)
  debuglog('Verified.')

  // Check entitlements if applicable
  if (opts.entitlements) {
    debuglog('Displaying entitlements...')
    const result = await execFileAsync('codesign', [
      '--display',
      '--entitlements', ':-', // Write to standard output and strip off the blob header
      opts.app
    ])
    debuglog('Entitlements:\n', result)
  }
}

async function determineIdentitiesForSigning (opts) {
  if (opts.identity) {
    debuglog('`identity` passed in arguments.')
    if (opts['identity-validation'] === false) {
      if (!(opts.identity instanceof Identity)) {
        opts.identity = new Identity(opts.identity)
      }
      return [opts.identity]
    }
    return findIdentitiesAsync(opts, opts.identity)
  } else {
    debugwarn('No `identity` passed in arguments...')
    if (opts.platform === 'mas') {
      if (opts.type === 'distribution') {
        debuglog('Finding `3rd Party Mac Developer Application` certificate for signing app distribution in the Mac App Store...')
        return findIdentitiesAsync(opts, '3rd Party Mac Developer Application:')
      } else {
        debuglog('Finding `Mac Developer` certificate for signing app in development for the Mac App Store signing...')
        return findIdentitiesAsync(opts, 'Mac Developer:')
      }
    } else {
      debuglog('Finding `Developer ID Application` certificate for distribution outside the Mac App Store...')
      return findIdentitiesAsync(opts, 'Developer ID Application:')
    }
  }
}

function setupEntitlementsForSigning (opts) {
  // Determine entitlements for code signing
  if (opts.platform === 'mas') {
    // To sign apps for Mac App Store, an entitlements file is required, especially for app sandboxing (as well some other services).
    // Fallback entitlements for sandboxing by default: Note this may cause troubles while running an signed app due to missing keys special to the project.
    // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
    if (!opts.entitlements) {
      const filePath = path.join(__dirname, 'default.entitlements.mas.plist')
      debugwarn('No `entitlements` passed in arguments:', '\n',
        '* Sandbox entitlements are required for Mac App Store distribution, your codesign entitlements file is default to:', filePath)
      opts.entitlements = filePath
    }
    if (!opts['entitlements-inherit']) {
      const filePath = path.join(__dirname, 'default.entitlements.mas.inherit.plist')
      debugwarn('No `entitlements-inherit` passed in arguments:', '\n',
        '* Sandbox entitlements file for enclosed app files is default to:', filePath)
      opts['entitlements-inherit'] = filePath
    }
    // The default value for opts['entitlements-file'] will be processed later
  } else {
    // Not necessary to have entitlements for non Mac App Store distribution
    if (!opts.entitlements) {
      debugwarn('No `entitlements` passed in arguments:', '\n',
        '* Provide `entitlements` to specify entitlements file for codesign.')
    } else {
      // If entitlements is provided as a boolean flag, fallback to default
      if (opts.entitlements === true) {
        const filePath = path.join(__dirname, 'default.entitlements.darwin.plist')
        debugwarn('`entitlements` not specified in arguments:', '\n',
          '* Provide `entitlements` to specify entitlements file for codesign.', '\n',
          '* Entitlements file is default to:', filePath)
        opts.entitlements = filePath
      }
      if (!opts['entitlements-inherit']) {
        const filePath = path.join(__dirname, 'default.entitlements.darwin.inherit.plist')
        debugwarn('No `entitlements-inherit` passed in arguments:', '\n',
          '* Entitlements file for enclosed app files is default to:', filePath)
        opts['entitlements-inherit'] = filePath
      }
      // The default value for opts['entitlements-file'] will be processed later
    }
  }
}

async function executePreSignOperations (opts) {
  if (opts['pre-embed-provisioning-profile'] === false) {
    debugwarn('Pre-sign operation disabled for provisioning profile embedding:', '\n',
      '* Enable by setting `pre-embed-provisioning-profile` to `true`.')
  } else {
    debuglog('Pre-sign operation enabled for provisioning profile:', '\n',
      '* Disable by setting `pre-embed-provisioning-profile` to `false`.')
    await preEmbedProvisioningProfile(opts)
  }

  if (opts['pre-auto-entitlements'] === false) {
    debugwarn('Pre-sign operation disabled for entitlements automation.')
  } else {
    debuglog('Pre-sign operation enabled for entitlements automation with versions >= `1.1.1`:', '\n',
      '* Disable by setting `pre-auto-entitlements` to `false`.')
    if (opts.entitlements && (!opts.version || compareVersion(opts.version, '1.1.1') >= 0)) {
      // Enable Mac App Store sandboxing without using temporary-exception, introduced in Electron v1.1.1. Relates to electron#5601
      await preAutoEntitlements(opts)
    }
  }

  // preAutoEntitlements may update opts.entitlements,
  // so we wait after it's done before giving opts['entitlements-loginhelper'] its default value
  if (opts.entitlements) {
    if (!opts['entitlements-loginhelper']) {
      // Default to App Sandbox enabled
      const filePath = opts.entitlements
      debugwarn('No `entitlements-loginhelper` passed in arguments:', '\n',
        '* Entitlements file for login helper is default to:', filePath)
      opts['entitlements-loginhelper'] = filePath
    }
  }
}

/**
 * This function returns a promise signing the application.
 * @function
 * @param {mixed} opts - Options.
 * @returns {Promise} Promise.
 */
const signAsync = module.exports.signAsync = async function (opts) {
  debuglog('electron-osx-sign@%s', pkg.version)
  await validateSignOptsAsync(opts)
  opts.identity = await determineIdentityForSigning(await determineIdentitiesForSigning(opts))
  setupEntitlementsForSigning(opts)
  await executePreSignOperations(opts)
  debuglog('Signing application...', '\n',
    '> Application:', opts.app, '\n',
    '> Platform:', opts.platform, '\n',
    '> Entitlements:', opts.entitlements, '\n',
    '> Child entitlements:', opts['entitlements-inherit'], '\n',
    '> Login helper entitlements:', opts['entitlements-loginhelper'], '\n',
    '> Additional binaries:', opts.binaries, '\n',
    '> Identity:', opts.identity)
  await signApplicationAsync(opts)
  // Post-sign operations
  debuglog('Application signed.')
}

/**
 * This function is a normal callback implementation.
 * @function
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 */
module.exports.sign = function (opts, cb) {
  signAsync(opts)
    .then(() => {
      debuglog('Application signed: ' + opts.app)
      if (cb) cb()
    })
    .catch(err => {
      debuglog('Sign failed:')
      if (err.message) debuglog(err.message)
      else if (err.stack) debuglog(err.stack)
      else debuglog(err)
      if (cb) cb(err)
    })
}
