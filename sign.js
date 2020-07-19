/**
 * @module sign
 */

'use strict'

const path = require('path')

const Promise = require('bluebird')
const compareVersion = require('compare-version')

const pkg = require('./package.json')
const util = require('./util')
const debuglog = util.debuglog
const debugwarn = util.debugwarn
const getAppContentsPath = util.getAppContentsPath
const getTempFilePath = util.getTempFilePath
const execFileAsync = util.execFileAsync
const isZipFileAsync = util.isZipFileAsync
const validateOptsAppAsync = util.validateOptsAppAsync
const validateOptsPlatformAsync = util.validateOptsPlatformAsync
const walkAsync = util.walkAsync
const Identity = require('./util-identities').Identity
const findIdentitiesAsync = require('./util-identities').findIdentitiesAsync
const ProvisioningProfile = require('./util-provisioning-profiles').ProvisioningProfile
const preEmbedProvisioningProfile = require('./util-provisioning-profiles').preEmbedProvisioningProfile
const preAutoEntitlements = require('./util-entitlements').preAutoEntitlements

const osRelease = require('os').release()

/**
 * This function returns a promise validating opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateOptsBinariesAsync (opts) {
  return new Promise(function (resolve, reject) {
    if (opts.binaries) {
      if (!Array.isArray(opts.binaries)) {
        reject(new Error('Additional binaries should be an Array.'))
        return
      }
      // TODO: Presence check for binary files, reject if any does not exist
    }
    resolve()
  })
}

/**
 * This function returns a promise validating all options passed in opts.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateSignOptsAsync (opts) {
  if (opts.ignore && !(opts.ignore instanceof Array)) {
    opts.ignore = [opts.ignore]
  }

  if (opts['provisioning-profile']) {
    if (typeof opts['provisioning-profile'] !== 'string' && !(opts['provisioning-profile'] instanceof ProvisioningProfile)) return Promise.reject(new Error('Path to provisioning profile should be a string or a ProvisioningProfile object.'))
  }

  if (opts['type']) {
    if (opts['type'] !== 'development' && opts['type'] !== 'distribution') return Promise.reject(new Error('Type must be either `development` or `distribution`.'))
  } else {
    opts['type'] = 'distribution'
  }

  if (opts['traverse-archives'] && typeof opts['traverse-archives'] !== 'boolean' && !(opts['traverse-archives'] instanceof Array)) {
    opts['traverse-archives'] = [opts['traverse-archives']]
  }

  return Promise.map([
    validateOptsAppAsync,
    validateOptsPlatformAsync,
    validateOptsBinariesAsync
  ], function (validate) {
    return validate(opts)
  })
}

/**
 * This function returns a promise verifying the code sign of application bundle.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving output.
 */
function verifySignApplicationAsync (opts) {
  // Verify with codesign
  var compareVersion = require('compare-version')
  debuglog('Verifying application bundle with codesign...')

  var promise = execFileAsync('codesign', [
    '--verify',
    '--deep'
  ]
    .concat(
      opts['strict-verify'] !== false &&
      compareVersion(osRelease, '15.0.0') >= 0 // Strict flag since darwin 15.0.0 --> OS X 10.11.0 El Capitan
        ? ['--strict' +
            (opts['strict-verify']
             ? '=' + opts['strict-verify'] // Array should be converted to a comma separated string
             : '')]
        : [],
      ['--verbose=2', opts.app]))

  // Additionally test Gatekeeper acceptance for darwin platform
  if (opts.platform === 'darwin' && opts['gatekeeper-assess'] !== false) {
    promise = promise
      .then(function () {
        debuglog('Verifying Gatekeeper acceptance for darwin platform...')
        return execFileAsync('spctl', [
          '--assess',
          '--type', 'execute',
          '--verbose',
          '--ignore-cache',
          '--no-cache',
          opts.app
        ])
      })
  }

  return promise
    .thenReturn()
}

/**
 * Helper function to facilitate checking if to ignore signing a file.
 * @function
 * @param {Object} opts - Options.
 * @param {string} filePath - The file path to check whether to ignore.
 * @returns {boolean} Whether to ignore the file.
 */
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

/***
 * Helper function to facilitate whether to consider traversing a potential archive.
 * @function
 * @param {Object} opts - Options.
 * @param {string} humanReadableFilePath - The file path to check whether to include for traversal.
 * @returns {boolean} Whether to consider the potential archive for traversal.
 */
function shouldConsiderTraversingArchive (opts, humanReadableFilePath) {
  if (opts['traverse-archives']) {
    if (opts['traverse-archives'] === true) return true
    return opts['traverse-archives'].some(function (include) {
      if (typeof include === 'function') {
        return include(humanReadableFilePath)
      }
      return humanReadableFilePath.match(include)
    })
  }
  return false
}

/**
 * Sign a zip-like archive child component of the app bundle.
 * This piece of automation helps to traverse zip-like archives and sign any enclosing binary files. See #229.
 * @function
 * @param {Object} opts - Options.
 * @param {string[]} args - Command arguments for codesign excluding the file path.
 * @param {string} archiveFilePath - The path to the archive. It may be outside of the app bundle.
 * @param {string} humanReadableArchiveFilePath - A file path which may not exist but helps the user understand where it's located in the app bundle.
 * @returns {Promise} Promise.
 */
function signArchiveComponentsAsync (opts, args, archiveFilePath, humanReadableArchiveFilePath = undefined) {
  // Get temporary directory
  const tempDir = getTempFilePath('uncompressed')
  const tempArchive = getTempFilePath('recompressed.zip')

  // Unzip the file to the temporary directory
  debuglog(`Extracting... ${humanReadableArchiveFilePath} (real path: ${archiveFilePath}) to ${tempDir}`)
  return execFileAsync('unzip', [
    '-d', tempDir,
    archiveFilePath
  ])
    .then(function () {
      // Traverse the child components
      return walkAsync(tempDir)
        .then(function (childPaths) {
          return Promise.mapSeries(childPaths, function (filePath) {
            const relativePath = path.relative(tempDir, filePath)
            const humanReadableFilePath = path.join(humanReadableArchiveFilePath, relativePath)
            return signChildComponentAsync(opts, args, filePath, humanReadableFilePath)
          })
        })
        .then(function () {
          // Recompress a temporary archive
          debuglog(`Recompressing temp archive... ${tempArchive}`)
          return execFileAsync('zip', [
            '-r',
            tempArchive,
            '.'
          ], {
            cwd: tempDir
          })
        })
        .then(function () {
          // Replace the original file
          debuglog(`Replacing... ${humanReadableArchiveFilePath} (real path: ${archiveFilePath}) with updated archive`)
          return execFileAsync('mv', [
            '-f',
            tempArchive,
            archiveFilePath
          ])
        })
    }, function () {
      // Error from extracting files
      debuglog(`Failed to extract files from ${humanReadableArchiveFilePath} (real path: ${archiveFilePath}). The file probably isn't an unarchive?`)
    })
    .then(function () {
      // Final clean up
      debuglog(`Removing temp directory... ${tempDir}`)
      return execFileAsync('rm', [
        '-rf',
        tempDir
      ])
    })
}

/**
 * Sign a child component of the app bundle.
 * @function
 * @param {Object} opts - Options.
 * @param {string[]} args - Command arguments for codesign excluding the file path.
 * @param {string} filePath - The file to codesign that must exist. It may be outside of the app bundle.
 * @param {string} humanReadableFilePath - A file path which may not exist but helps the user understand where it's located in the app bundle. This could be a fake path to an image that's inside an archive in the app bundle, but needs uncompressing the archive first before reaching it.
 * @returns {Promise} Promise.
 */
function signChildComponentAsync (opts, args, filePath, humanReadableFilePath = undefined) {
  if (humanReadableFilePath === undefined) humanReadableFilePath = filePath

  if (ignoreFilePath(opts, humanReadableFilePath)) {
    debuglog('Skipped... ' + humanReadableFilePath)
    return Promise.resolve()
  }

  var promise
  if (shouldConsiderTraversingArchive(opts, humanReadableFilePath)) {
    // Sign the child components if the file is an archive
    promise = isZipFileAsync(filePath)
      .then(function (archive) {
        if (archive) {
          debuglog(`File ${humanReadableFilePath} (real path: ${filePath}) identified as a potential archive for traversal.`)
          return signArchiveComponentsAsync(opts, args, filePath, humanReadableFilePath)
        }
        return Promise.resolve()
      })
  } else {
    promise = Promise.resolve()
  }

  return promise
    .then(function () {
      debuglog('Signing... ' + humanReadableFilePath)
      return execFileAsync('codesign', args.concat(filePath))
    })
}

/**
 * This function returns a promise codesigning only.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function signApplicationAsync (opts) {
  return walkAsync(getAppContentsPath(opts))
    .then(function (childPaths) {
      if (opts.binaries) childPaths = childPaths.concat(opts.binaries)

      var args = [
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
        if (Array.isArray(opts['signature-flags'])) {
          optionsArguments = [...opts['signature-flags']]
        } else {
          const flags = opts['signature-flags'].split(',').map(function (flag) { return flag.trim() })
          optionsArguments = [...flags]
        }
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

      if (opts['restrict']) {
        optionsArguments.push('restrict')
        debugwarn('This flag is to be deprecated, consider using --signature-flags=restrict instead')
      }

      if (optionsArguments.length) {
        args.push('--options', [...new Set(optionsArguments)].join(','))
      }

      var promise
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
      if (opts.entitlements) {
        // Sign with entitlements
        promise = Promise.mapSeries(childPaths, function (filePath) {
          let entitlementsFile = opts['entitlements-inherit']
          if (filePath.includes('Library/LoginItems')) {
            entitlementsFile = opts['entitlements-loginhelper']
          }
          return signChildComponentAsync(opts, args.concat('--entitlements', entitlementsFile), filePath)
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            return execFileAsync('codesign', args.concat('--entitlements', opts.entitlements, opts.app))
          })
      } else {
        // Otherwise normally
        promise = Promise.mapSeries(childPaths, function (filePath) {
          return signChildComponentAsync(opts, args, filePath)
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            return execFileAsync('codesign', args.concat(opts.app))
          })
      }

      return promise
        .then(function () {
          // Verify code sign
          debuglog('Verifying...')
          var promise = verifySignApplicationAsync(opts)
            .then(function (result) {
              debuglog('Verified.')
            })

          // Check entitlements if applicable
          if (opts.entitlements) {
            promise = promise
              .then(function () {
                debuglog('Displaying entitlements...')
                return execFileAsync('codesign', [
                  '--display',
                  '--entitlements', ':-', // Write to standard output and strip off the blob header
                  opts.app
                ])
              })
              .then(function (result) {
                debuglog('Entitlements:', '\n',
                  result)
              })
          }

          return promise
        })
    })
}

/**
 * This function returns a promise signing the application.
 * @function
 * @param {mixed} opts - Options.
 * @returns {Promise} Promise.
 */
var signAsync = module.exports.signAsync = function (opts) {
  debuglog('electron-osx-sign@%s', pkg.version)
  return validateSignOptsAsync(opts)
    .then(function () {
      // Determine identity for signing
      var promise
      if (opts.identity) {
        debuglog('`identity` passed in arguments.')
        if (opts['identity-validation'] === false) {
          if (!(opts.identity instanceof Identity)) {
            opts.identity = new Identity(opts.identity)
          }
          return Promise.resolve()
        }
        promise = findIdentitiesAsync(opts, opts.identity)
      } else {
        debugwarn('No `identity` passed in arguments...')
        if (opts.platform === 'mas') {
          if (opts.type === 'distribution') {
            debuglog('Finding `3rd Party Mac Developer Application` certificate for signing app distribution in the Mac App Store...')
            promise = findIdentitiesAsync(opts, '3rd Party Mac Developer Application:')
          } else {
            debuglog('Finding `Mac Developer` certificate for signing app in development for the Mac App Store signing...')
            promise = findIdentitiesAsync(opts, 'Mac Developer:')
          }
        } else {
          debuglog('Finding `Developer ID Application` certificate for distribution outside the Mac App Store...')
          promise = findIdentitiesAsync(opts, 'Developer ID Application:')
        }
      }
      return promise
        .then(function (identities) {
          if (identities.length > 0) {
            // Identity(/ies) found
            if (identities.length > 1) {
              debugwarn('Multiple identities found, will use the first discovered.')
            } else {
              debuglog('Found 1 identity.')
            }
            opts.identity = identities[0]
          } else {
            // No identity found
            return Promise.reject(new Error('No identity found for signing.'))
          }
        })
    })
    .then(function () {
      // Determine entitlements for code signing
      var filePath
      if (opts.platform === 'mas') {
        // To sign apps for Mac App Store, an entitlements file is required, especially for app sandboxing (as well some other services).
        // Fallback entitlements for sandboxing by default: Note this may cause troubles while running an signed app due to missing keys special to the project.
        // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
        if (!opts.entitlements) {
          filePath = path.join(__dirname, 'default.entitlements.mas.plist')
          debugwarn('No `entitlements` passed in arguments:', '\n',
            '* Sandbox entitlements are required for Mac App Store distribution, your codesign entitlements file is default to:', filePath)
          opts.entitlements = filePath
        }
        if (!opts['entitlements-inherit']) {
          filePath = path.join(__dirname, 'default.entitlements.mas.inherit.plist')
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
            filePath = path.join(__dirname, 'default.entitlements.darwin.plist')
            debugwarn('`entitlements` not specified in arguments:', '\n',
              '* Provide `entitlements` to specify entitlements file for codesign.', '\n',
              '* Entitlements file is default to:', filePath)
            opts.entitlements = filePath
          }
          if (!opts['entitlements-inherit']) {
            filePath = path.join(__dirname, 'default.entitlements.darwin.inherit.plist')
            debugwarn('No `entitlements-inherit` passed in arguments:', '\n',
              '* Entitlements file for enclosed app files is default to:', filePath)
            opts['entitlements-inherit'] = filePath
          }
          // The default value for opts['entitlements-file'] will be processed later
        }
      }
    })
    .then(function () {
      // Pre-sign operations
      var preSignOperations = []

      if (opts['pre-embed-provisioning-profile'] === false) {
        debugwarn('Pre-sign operation disabled for provisioning profile embedding:', '\n',
          '* Enable by setting `pre-embed-provisioning-profile` to `true`.')
      } else {
        debuglog('Pre-sign operation enabled for provisioning profile:', '\n',
          '* Disable by setting `pre-embed-provisioning-profile` to `false`.')
        preSignOperations.push(preEmbedProvisioningProfile)
      }

      if (opts['pre-auto-entitlements'] === false) {
        debugwarn('Pre-sign operation disabled for entitlements automation.')
      } else {
        debuglog('Pre-sign operation enabled for entitlements automation with versions >= `1.1.1`:', '\n',
          '* Disable by setting `pre-auto-entitlements` to `false`.')
        if (opts.entitlements && (!opts.version || compareVersion(opts.version, '1.1.1') >= 0)) {
          // Enable Mac App Store sandboxing without using temporary-exception, introduced in Electron v1.1.1. Relates to electron#5601
          preSignOperations.push(preAutoEntitlements)
        }
      }

      // preAutoEntitlements may update opts.entitlements,
      // so we wait after it's done before giving opts['entitlements-loginhelper'] its default value
      preSignOperations.push(function (opts) {
        if (opts.entitlements) {
          if (!opts['entitlements-loginhelper']) {
            // Default to App Sandbox enabled
            const filePath = opts.entitlements
            debugwarn('No `entitlements-loginhelper` passed in arguments:', '\n',
              '* Entitlements file for login helper is default to:', filePath)
            opts['entitlements-loginhelper'] = filePath
          }
        }
      })

      return Promise.mapSeries(preSignOperations, function (preSignOperation) {
        return preSignOperation(opts)
      })
    })
    .then(function () {
      debuglog('Signing application...', '\n',
        '> Application:', opts.app, '\n',
        '> Platform:', opts.platform, '\n',
        '> Entitlements:', opts.entitlements, '\n',
        '> Child entitlements:', opts['entitlements-inherit'], '\n',
        '> Login helper entitlements:', opts['entitlements-loginhelper'], '\n',
        '> Additional binaries:', opts.binaries, '\n',
        '> Identity:', opts.identity)
      return signApplicationAsync(opts)
    })
    .then(function () {
      // Post-sign operations
      debuglog('Application signed.')
    })
}

/**
 * This function is a normal callback implementation.
 * @function
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 */
module.exports.sign = function (opts, cb) {
  signAsync(opts)
    .then(function () {
      debuglog('Application signed: ' + opts.app)
      if (cb) cb()
    })
    .catch(function (err) {
      debuglog('Sign failed:')
      if (err.message) debuglog(err.message)
      else if (err.stack) debuglog(err.stack)
      else debuglog(err)
      if (cb) cb(err)
    })
}
