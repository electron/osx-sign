/**
 * @module util-provisioning-profiles
 */

'use strict'

const { promises: fs } = require('fs')
const path = require('path')
const plist = require('plist')

const { debuglog, debugwarn, execFileAsync, getAppContentsPath } = require('./util')

class ProvisioningProfile {
  /**
   * @constructor
   * @param {string} filePath - Path to provisioning profile.
   * @param {Object} message - Decoded message in provisioning profile.
   */
  constructor (filePath, message) {
    this.filePath = filePath
    this.message = message
  }

  get name () {
    return this.message.Name
  }

  get platforms () {
    if ('ProvisionsAllDevices' in this.message) {
      return ['darwin'] // Developer ID
    } else if (this.type === 'distribution') {
      return ['mas'] // Mac App Store
    } else {
      return ['darwin', 'mas'] // Mac App Development
    }
  }

  get type () {
    if ('ProvisionedDevices' in this.message) {
      return 'development' // Mac App Development
    } else {
      return 'distribution' // Developer ID or Mac App Store
    }
  }
}

module.exports.ProvisioningProfile = ProvisioningProfile

/**
 * Returns a promise resolving to a ProvisioningProfile instance based on file.
 * @function
 * @param {string} filePath - Path to provisioning profile.
 * @param {string} keychain - Keychain to use when unlocking provisioning profile.
 * @returns {Promise} Promise.
 */
const getProvisioningProfileAsync = module.exports.getProvisioningProfileAsync = async function (filePath, keychain = null) {
  const securityArgs = [
    'cms',
    '-D', // Decode a CMS message
    '-i', filePath // Use infile as source of data
  ]

  if (keychain) {
    securityArgs.push('-k', keychain)
  }

  const result = await execFileAsync('security', securityArgs)
  const provisioningProfile = new ProvisioningProfile(filePath, plist.parse(result))
  debuglog('Provisioning profile:', '\n',
    '> Name:', provisioningProfile.name, '\n',
    '> Platforms:', provisioningProfile.platforms, '\n',
    '> Type:', provisioningProfile.type, '\n',
    '> Path:', provisioningProfile.filePath, '\n',
    '> Message:', provisioningProfile.message)
  return provisioningProfile
}

/**
 * Returns a promise resolving to a list of suitable provisioning profile within the current working directory.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
const findProvisioningProfilesAsync = module.exports.findProvisioningProfilesAsync = async function (opts) {
  const provisioningProfiles = []
  const dirPath = process.cwd()
  for (const name of await fs.readdir(dirPath)) {
    const filePath = path.join(dirPath, name)
    const stat = await fs.lstat(filePath)
    if (stat.isFile() && path.extname(filePath) === '.provisionprofile') {
      const provisioningProfile = await getProvisioningProfileAsync(filePath)
      if (provisioningProfile.platforms.includes(opts.platform) && provisioningProfile.type === opts.type) {
        provisioningProfiles.push(provisioningProfile)
      } else {
        debugwarn(`Provisioning profile above ignored, not for ${opts.platform} ${opts.type}.`)
      }
    }
  }

  return provisioningProfiles
}

async function embedProvisioningProfile (opts) {
  if (opts['provisioning-profile']) {
    debuglog('Looking for existing provisioning profile...')
    const embeddedFilePath = path.join(getAppContentsPath(opts), 'embedded.provisionprofile')
    try {
      await fs.lstat(embeddedFilePath)
      debuglog('Found embedded provisioning profile:', '\n',
        '* Please manually remove the existing file if not wanted.', '\n',
        '* Current file at:', embeddedFilePath)
    } catch (err) {
      if (err.code === 'ENOENT') { // File does not exist
        debuglog('Embedding provisioning profile...')
        await fs.copyFile(opts['provisioning-profile'].filePath, embeddedFilePath)
      } else {
        throw err
      }
    }
  }
}

/**
 * Returns a promise embedding the provisioning profile in the app Contents folder.
 * @function
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
module.exports.preEmbedProvisioningProfile = async function (opts) {
  if (opts['provisioning-profile']) {
    // User input provisioning profile
    debuglog('`provisioning-profile` passed in arguments.')
    if (opts['provisioning-profile'] instanceof ProvisioningProfile) {
      await embedProvisioningProfile(opts)
    } else {
      opts['provisioning-profile'] = await getProvisioningProfileAsync(opts['provisioning-profile'], opts.keychain)
      await embedProvisioningProfile(opts)
    }
  } else {
    // Discover provisioning profile
    debuglog('No `provisioning-profile` passed in arguments, will find in current working directory and in user library...')
    const provisioningProfiles = await findProvisioningProfilesAsync(opts)
    if (provisioningProfiles.length > 0) {
      // Provisioning profile(s) found
      if (provisioningProfiles.length > 1) {
        debuglog('Multiple provisioning profiles found, will use the first discovered.')
      } else {
        debuglog('Found 1 provisioning profile.')
      }
      opts['provisioning-profile'] = provisioningProfiles[0]
    } else {
      // No provisioning profile found
      debuglog('No provisioning profile found, will not embed profile in app contents.')
    }
    await embedProvisioningProfile(opts)
  }
}
