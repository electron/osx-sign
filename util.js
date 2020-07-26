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

// TODO: Simplify with Array.prototype.flat when minimum Node version is >= 12
/**
 * This function returns a flattened list of elements from an array of lists.
 * @function
 * @param {*} list - List.
 * @returns Flattened list.
 */
var flatList = module.exports.flatList = function (list) {
  function populateResult (list) {
    if (!Array.isArray(list)) {
      result.push(list)
    } else if (list.length > 0) {
      for (const item of list) if (item) populateResult(item)
    }
  }

  var result = []
  populateResult(list)
  return result
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
 * This function returns a promise resolving the file path if file binary.
 * @function
 * @param {string} filePath - Path to file.
 * @returns {Promise} Promise resolving file path or undefined.
 */
async function getFilePathIfBinaryAsync (filePath) {
  if (await isBinaryFile(filePath)) {
    return filePath
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
 * This function returns a promise resolving all child paths within the directory specified.
 * @function
 * @param {string} dirPath - Path to directory.
 * @returns {Promise} Promise resolving child paths needing signing in order.
 */
module.exports.walkAsync = function (dirPath) {
  debuglog('Walking... ' + dirPath)

  function _walkAsync (dirPath) {
    return fs.readdir(dirPath)
      .then(function (names) {
        return Promise.map(names, function (name) {
          var filePath = path.join(dirPath, name)
          return fs.lstat(filePath)
            .then(function (stat) {
              if (stat.isFile()) {
                switch (path.extname(filePath)) {
                  case '.cstemp': // Temporary file generated from past codesign
                    debuglog('Removing... ' + filePath)
                    return fs.unlink(filePath)
                      .thenReturn(undefined)
                  default:
                    return getFilePathIfBinaryAsync(filePath)
                }
              } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
                return _walkAsync(filePath)
                  .then(function (result) {
                    switch (path.extname(filePath)) {
                      case '.app': // Application
                      case '.framework': // Framework
                        result.push(filePath)
                    }
                    return result
                  })
              }
            })
        })
      })
  }

  return _walkAsync(dirPath)
    .then(flatList)
}
