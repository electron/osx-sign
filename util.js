/**
 * @module util
 */

'use strict'

const child = require('child_process')
const { promises: fs } = require('fs')
const path = require('path')

const Promise = require('bluebird')
const debug = require('debug')
const { isBinaryFile } = require('isbinaryfile')

/**
 * This callback is used across signing and flattening.
 * @callback RequestCallback
 * @param {?Error} err
 */

/** @function */
const debuglog = module.exports.debuglog = debug('electron-osx-sign')
debuglog.log = console.log.bind(console)

/** @function */
const debugwarn = module.exports.debugwarn = debug('electron-osx-sign:warn')
debugwarn.log = console.warn.bind(console)

/** @function */
const removePassword = function (input) {
  return input.replace(/(-P |pass:|\/p|-pass )([^ ]+)/, function (match, p1, p2) {
    return `${p1}***`
  })
}

/** @function */
module.exports.execFileAsync = function (file, args, options) {
  if (debuglog.enabled) {
    debuglog('Executing...', file, args && Array.isArray(args) ? removePassword(args.join(' ')) : '')
  }

  return new Promise(function (resolve, reject) {
    child.execFile(file, args, options, function (err, stdout, stderr) {
      if (err) {
        debuglog('Error executing file:', '\n',
          '> Stdout:', stdout, '\n',
          '> Stderr:', stderr)
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * This function returns the path to app contents.
 * @function
 * @param {Object} opts - Options.
 * @returns {string} App contents path.
 */
var getAppContentsPath = module.exports.getAppContentsPath = function (opts) {
  return path.join(opts.app, 'Contents')
}

/**
 * This function returns the path to app frameworks within contents.
 * @function
 * @param {Object} opts - Options.
 * @returns {string} App frameworks path.
 */
var getAppFrameworksPath = module.exports.getAppFrameworksPath = function (opts) {
  return path.join(getAppContentsPath(opts), 'Frameworks')
}

/**
 * This function returns a promise with platform resolved.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving platform.
 */
async function detectElectronPlatformAsync (opts) {
  const appFrameworksPath = getAppFrameworksPath(opts)
  // The presence of Squirrel.framework identifies a Mac App Store build, see
  // https://github.com/electron/electron/blob/2fb14f53fe8c04397a49d32fb293547db27916ed/BUILD.gn#L484-L509
  try {
    await fs.lstat(path.join(appFrameworksPath, 'Squirrel.framework'))
    return 'darwin'
  } catch {
    return 'mas'
  }
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.validateOptsAppAsync = async function (opts) {
  if (!opts.app) {
    throw new Error('Path to application must be specified.')
  }
  if (path.extname(opts.app) !== '.app') {
    throw new Error('Extension of application must be `.app`.')
  }

  await fs.lstat(opts.app)
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.validateOptsPlatformAsync = async function (opts) {
  if (opts.platform) {
    if (opts.platform === 'mas' || opts.platform === 'darwin') {
      return Promise.resolve()
    } else {
      debugwarn('`platform` passed in arguments not supported, checking Electron platform...')
    }
  } else {
    debugwarn('No `platform` passed in arguments, checking Electron platform...')
  }

  opts.platform = await detectElectronPlatformAsync(opts)
}

/**
 * Finds all of the subpaths that need to be signed.
 * @function
 * @param {string} dirPath - The directory to search.
 * @returns {Promise<string[]>} The child paths needing signing in depth-first order.
 */
const pathsToSignAsync = module.exports.pathsToSignAsync = async function (dirPath) {
  debuglog(`Walking... ${dirPath}`)
  const pathsToSign = []

  for (const name of await fs.readdir(dirPath)) {
    const filePath = path.join(dirPath, name)
    const stat = await fs.lstat(filePath)
    if (stat.isFile()) {
      if (path.extname(filePath) === '.cstemp') {
        // Temporary file generated from past codesign
        debuglog('Removing... ' + filePath)
        await fs.unlink(filePath)
      } else if (await isBinaryFile(filePath)) {
        pathsToSign.push(filePath)
      }
    } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
      pathsToSign.push.apply(pathsToSign, await pathsToSignAsync(filePath))
      switch (path.extname(filePath)) {
        case '.app': // Application
        case '.framework': // Framework
          pathsToSign.push(filePath)
      }
    }
  }

  return pathsToSign
}
