/**
 * @module util
 */

'use strict'

const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const Promise = require('bluebird')
const debug = require('debug')

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
const isBinaryFileAsync = module.exports.isBinaryFileAsync = Promise.promisify(require('isbinaryfile'))

/**
 * Reads the beginning of a file and returns whether it contains the signature.
 * @function
 * @param {string} filePath - Path to a file.
 * @param {Buffer} signature - Binary signature in a Buffer.
 * @returns {Promise} Whether the file starts with the signature.
 */
function testFileSignatureAsync (filePath, signature) {
  // Based on isbinaryfile's implementation

  return new Promise(function (resolve, reject) {
    fs.stat(filePath, function (err, stat) {
      if (err) return reject(err)
      if (!stat.isFile()) return resolve(false)

      fs.open(filePath, 'r', function (err, descriptor) {
        if (err) return reject(err)
        const bytes = Buffer.alloc(signature.length)
        fs.read(descriptor, bytes, 0, bytes.length, 0, function (err, size, bytes) {
          if (err) return reject(err)
          fs.close(descriptor, function (err) {
            if (err) return reject(err)
            // Match signature
            resolve(size === signature.length && Buffer.compare(bytes, signature) === 0)
          })
        })
      })
    })
  })
}

// Zip file signature taken from https://en.wikipedia.org/wiki/List_of_file_signatures
const zipFileSignature = Buffer.from([0x50, 0x4B, 0x03, 0x04])

/**
 * Returns whether the file begins with a zip file signature.
 * @function
 * @param {string} filePath - Path to a file.
 * @returns {Promise} Whether the file is a zip archive.
 */
module.exports.isZipFileAsync = function (filePath) {
  return testFileSignatureAsync(filePath, zipFileSignature)
}

let tempFileCounter = 0

/** @function */
module.exports.getTempFilePath = function (fileName) {
  return path.join(os.tmpdir(), `tmp-${process.pid.toString(16)}-${(tempFileCounter++).toString(16)}-${fileName}`)
}

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

/** @function */
const lstatAsync = module.exports.lstatAsync = Promise.promisify(fs.lstat)

/** @function */
const readdirAsync = module.exports.readdirAsync = Promise.promisify(fs.readdir)

/** @function */
module.exports.readFileAsync = Promise.promisify(fs.readFile)

/** @function */
module.exports.writeFileAsync = Promise.promisify(fs.writeFile)

/** @function */
const unlinkAsync = Promise.promisify(fs.unlink)

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
      for (let item of list) if (item) populateResult(item)
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
 * This function returns a promise copying a file from the source to the target.
 * @function
 * @param {string} source - Source path.
 * @param {string} target - Target path.
 * @returns {Promise} Promise.
 */
module.exports.copyFileAsync = function (source, target) {
  debuglog('Copying file...', '\n',
    '> Source:', source, '\n',
    '> Target:', target)
  return new Promise(function (resolve, reject) {
    var readStream = fs.createReadStream(source)
    readStream.on('error', reject)
    var writeStream = fs.createWriteStream(target)
    writeStream.on('error', reject)
    writeStream.on('close', resolve)
    readStream.pipe(writeStream)
  })
}

/**
 * This function returns a promise with platform resolved.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving platform.
 */
var detectElectronPlatformAsync = module.exports.detectElectronPlatformAsync = function (opts) {
  return new Promise(function (resolve) {
    var appFrameworksPath = getAppFrameworksPath(opts)
    // The presence of Squirrel.framework identifies a Mac App Store build as used in https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md
    return lstatAsync(path.join(appFrameworksPath, 'Squirrel.framework'))
      .then(function () {
        resolve('darwin')
      })
      .catch(function () {
        resolve('mas')
      })
  })
}

/**
 * This function returns a promise resolving the file path if file binary.
 * @function
 * @param {string} filePath - Path to file.
 * @returns {Promise} Promise resolving file path or undefined.
 */
var getFilePathIfBinaryAsync = module.exports.getFilePathIfBinaryAsync = function (filePath) {
  return isBinaryFileAsync(filePath)
    .then(function (isBinary) {
      return isBinary ? filePath : undefined
    })
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.validateOptsAppAsync = function (opts) {
  if (!opts.app) {
    return Promise.reject(new Error('Path to aplication must be specified.'))
  }
  if (path.extname(opts.app) !== '.app') {
    return Promise.reject(new Error('Extension of application must be `.app`.'))
  }
  return lstatAsync(opts.app)
    .thenReturn()
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.validateOptsPlatformAsync = function (opts) {
  if (opts.platform) {
    if (opts.platform === 'mas' || opts.platform === 'darwin') {
      return Promise.resolve()
    } else {
      debugwarn('`platform` passed in arguments not supported, checking Electron platform...')
    }
  } else {
    debugwarn('No `platform` passed in arguments, checking Electron platform...')
  }

  return detectElectronPlatformAsync(opts)
    .then(function (platform) {
      opts.platform = platform
    })
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
    return readdirAsync(dirPath)
      .then(function (names) {
        return Promise.map(names, function (name) {
          var filePath = path.join(dirPath, name)
          return lstatAsync(filePath)
            .then(function (stat) {
              if (stat.isFile()) {
                switch (path.extname(filePath)) {
                  case '.cstemp': // Temporary file generated from past codesign
                    debuglog('Removing... ' + filePath)
                    return unlinkAsync(filePath)
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
