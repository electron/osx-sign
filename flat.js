/**
 * @module flat
 */

'use strict'

const path = require('path')

const pkg = require('./package.json')
const { debuglog, debugwarn, execFileAsync, validateOptsAppAsync, validateOptsPlatformAsync } = require('./util')
const { determineIdentityForSigning, findIdentitiesAsync, Identity } = require('./util-identities')

/**
 * This function returns a promise validating all options passed in opts.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
async function validateFlatOptsAsync (opts) {
  if (opts.pkg) {
    if (typeof opts.pkg !== 'string') throw new Error('`pkg` must be a string.')
    if (path.extname(opts.pkg) !== '.pkg') throw new Error('Extension of output package must be `.pkg`.')
  } else {
    debugwarn('No `pkg` passed in arguments, will fallback to default inferred from the given application.')
    opts.pkg = path.join(path.dirname(opts.app), path.basename(opts.app, '.app') + '.pkg')
  }

  if (opts.install) {
    if (typeof opts.install !== 'string') throw new Error('`install` must be a string.')
  } else {
    debugwarn('No `install` passed in arguments, will fallback to default `/Applications`.')
    opts.install = '/Applications'
  }

  await validateOptsAppAsync(opts)
  await validateOptsPlatformAsync(opts)
}

/**
 * This function returns a promise flattening the application.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
async function flatApplicationAsync (opts) {
  const args = [
    '--component', opts.app, opts.install,
    '--sign', opts.identity.name,
    opts.pkg
  ]
  if (opts.keychain) {
    args.unshift('--keychain', opts.keychain)
  }
  if (opts.scripts) {
    args.unshift('--scripts', opts.scripts)
  }

  debuglog('Flattening... ' + opts.app)
  await execFileAsync('productbuild', args)
}

async function determineIdentitiesForSigning (opts) {
  if (opts.identity) {
    debuglog('`identity` passed in arguments.')
    if (opts['identity-validation'] === false || opts.identity instanceof Identity) {
      return [opts.identity]
    }
    return findIdentitiesAsync(opts, opts.identity)
  } else {
    debugwarn('No `identity` passed in arguments...')
    if (opts.platform === 'mas') {
      debuglog('Finding `3rd Party Mac Developer Installer` certificate for flattening app distribution in the Mac App Store...')
      return findIdentitiesAsync(opts, '3rd Party Mac Developer Installer:')
    } else {
      debuglog('Finding `Developer ID Application` certificate for distribution outside the Mac App Store...')
      return findIdentitiesAsync(opts, 'Developer ID Installer:')
    }
  }
}

/**
 * This function is exported and returns a promise flattening the application.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
const flatAsync = module.exports.flatAsync = async function (opts) {
  debuglog('electron-osx-sign@%s', pkg.version)
  await validateFlatOptsAsync(opts)
  opts.identity = await determineIdentityForSigning(await determineIdentitiesForSigning(opts))
  // Pre-flat operations
  debuglog('Flattening application...', '\n',
    '> Application:', opts.app, '\n',
    '> Package output:', opts.pkg, '\n',
    '> Install path:', opts.install, '\n',
    '> Identity:', opts.identity, '\n',
    '> Scripts:', opts.scripts)
  await flatApplicationAsync(opts)
  // Post-flat operations
  debuglog('Application flattened.')
}

/**
 * This function is exported with normal callback implementation.
 * @function
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 */
module.exports.flat = function (opts, cb) {
  flatAsync(opts)
    .then(() => {
      debuglog('Application flattened, saved to: ', opts.app)
      if (cb) cb()
    })
    .catch(err => {
      debuglog('Flat failed:')
      if (err.message) debuglog(err.message)
      else if (err.stack) debuglog(err.stack)
      else debuglog(err)
      if (cb) cb(err)
    })
}
