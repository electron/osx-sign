# electron-osx-sign [![npm][npm_img]][npm_url] [![Build Status][travis_img]][travis_url]


Code-signing for packaged Electron OS X apps.

Please visit our [Wiki](https://github.com/electron-userland/electron-osx-sign/wiki) hosted here on GitHub for walk-throughs and notes from past projects shipped with [electron-packager] and `electron-osx-sign`.

*Note: The signing procedure implemented in this package is based on what described in [Mac App Store Submission Guide](https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md).*

### An [OPEN Open Source Project](http://openopensource.org/)

Individuals making significant and valuable contributions are given commit-access to the project to contribute as they see fit. This project is more like an open wiki than a standard guarded open source project.

## Installation

```sh
# For use in npm scripts
npm install electron-osx-sign --save
```

```sh
# For use from CLI
npm install electron-osx-sign -g
```

*Note: `electron-osx-sign` is a dependency of `electron-packager` as of 6.0.0 for signing apps on OS X. However, please install this package globally for more customization beyond specifying identity and entitlements.*

## Usage

### electron-osx-sign

#### From the Command Line

```sh
electron-osx-sign <app> [additional-binaries...] [--options...]
```

Example:

```sh
electron-osx-sign path/to/my.app
```

For details on the optional flags, run `electron-osx-sign --help` or see [electron-osx-sign-usage.txt](https://github.com/electron-userland/electron-osx-sign/blob/master/bin/electron-osx-sign-usage.txt).

#### From the API

```javascript
var sign = require('electron-osx-sign')
sign(opts[, function done (err) {}])
```

Example:

##### sign(opts, callback)

```javascript
var sign = require('electron-osx-sign')
sign({
  app: 'path/to/my.app'
}, function done (err) {
  if (err) {
    // Handle the error
    return;
  }
  // Regular callback
})
```

###### opts

**Required**

`app` - *String*

Path to the application package.
Needs file extension `.app`.

**Optional**

`binaries` - *Array*

Path to additional binaries that will be signed along with built-ins of Electron.
Default to `null`.

`entitlements` - *String*

Path to entitlements file for signing the app.
See [default.mas.entitlements](https://github.com/electron-userland/electron-osx-sign/blob/master/default.mas.entitlements) or [default.darwin.entitlements](https://github.com/electron-userland/electron-osx-sign/blob/master/default.darwin.entitlements) for default.

`entitlements-inherit` - *String*

Path to child entitlements which inherit the security settings for signing frameworks and bundles of a distribution. *This option only applies when signing with `entitlements` provided, or for a `mas` platform version.*
See [default.mas.inherit.entitlements](https://github.com/electron-userland/electron-osx-sign/blob/master/default.mas.inherit.entitlements) or [default.darwin.inherit.entitlements](https://github.com/electron-userland/electron-osx-sign/blob/master/default.darwin.inherit.entitlements) for default.

`identity` - *String*

Name of certificate to use when signing.
Default to retrieve from `opts.keychain` (see below) or system default keychain.

Signing platform `mas` will look for `3rd Party Mac Developer Application: * (*)`, and platform `darwin` will look for `Developer ID Application: * (*)` by default.

`keychain` - *String*

The keychain name.
Default to system default keychain (`login.keychain`).

`ignore` - *String*

Regex or function that signals ignoring a file before signing.
Default to undefined.

`platform` - *String*

Build platform of Electron.
Allowed values: `darwin`, `mas`.
Default to auto detect from presence of `Squirrel.framework` within the application package.

`requirements` - *String*

Specify the criteria that you recommend to be used to evaluate the code signature.
See more info from https://developer.apple.com/library/mac/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html

###### callback

`err` - *Error*

### electron-osx-flat

#### From the Command Line

```sh
electron-osx-flat <app> [--options...]
```

Example:

```sh
electron-osx-flat path/to/my.app
```

For details on the optional flags, run `electron-osx-flat --help` or see [electron-osx-flat-usage.txt](https://github.com/electron-userland/electron-osx-sign/blob/master/bin/electron-osx-flat-usage.txt).

#### From the API

##### flat(opts, callback)

```javascript
var flat = require('electron-osx-sign').flat
flat(opts[, function done (err) {}])
```

Example:

```javascript
var flat = require('electron-osx-sign').flat
flat({
  app: 'path/to/my.app'
}, function done (err) {
  if (err) {
    // Handle the error
    return;
  }
  // Regular callback
})
```

###### opts

**Required**

`app` - *String*

Path to the application package.
Needs file extension `.app`.

**Optional**

`identity` - *String*

Name of certificate to use when flattening.
Default to retrieve from `opts.keychain`(see below) or system default keychain.

Flattening platform `mas` will look for `3rd Party Mac Developer Installer: * (*)`, and platform `darwin` will look for `Developer ID Installer: * (*)` by default.

`install` - *String*

Path to install for the bundle.
Default to `/Applications`.

`keychain` - *String*

The keychain name.
Default to `login.keychain`.

`platform` - *String*

Build platform of Electron. Allowed values: `darwin`, `mas`.
Default to auto detect from application.

`pkg` - *String*

Path to the output flattened package.
Needs file extension `.pkg`.

###### callback

`err` - *Error*

## Debug

As of release v0.3.1, external module `debug` is used to display logs and messages; remember to `export DEBUG=electron-osx-sign*` when necessary.

## Test

As developer certificates are required for `codesign` in OS X, this module may not be tested via online build services. If you wish to test out this module, enter:

```
npm test
```

from the dev directory, and tell us if all tests should pass.

When this command is fun for the first time: `electron-download` will download all major releases of Electron available for OS X from 0.24.0, and save to `~/.electron/`, which might take up less than 1GB of disk space.

A successful testing should look something like:

```
$ npm test

> electron-osx-sign@0.3.2 pretest electron-osx-sign
> rimraf test/work

> electron-osx-sign@0.3.2 test electron-osx-sign
> standard && tape test

Calling electron-download before running tests...
Running tests...
TAP version 13
# setup
# defaults-test:v0.24.0-darwin-x64
ok 1 app signed
ok 2 app flattened
# defaults-test:v0.25.0-darwin-x64
ok 3 app signed
ok 4 app flattened
# defaults-test:v0.26.0-darwin-x64
ok 5 app signed
ok 6 app flattened
# defaults-test:v0.27.0-darwin-x64
ok 7 app signed
ok 8 app flattened
# defaults-test:v0.28.0-darwin-x64
ok 9 app signed
ok 10 app flattened
# defaults-test:v0.29.0-darwin-x64
ok 11 app signed
ok 12 app flattened
# defaults-test:v0.30.0-darwin-x64
ok 13 app signed
ok 14 app flattened
# defaults-test:v0.31.0-darwin-x64
ok 15 app signed
ok 16 app flattened
# defaults-test:v0.32.0-darwin-x64
ok 17 app signed
ok 18 app flattened
# defaults-test:v0.33.0-darwin-x64
ok 19 app signed
ok 20 app flattened
# defaults-test:v0.34.0-darwin-x64
ok 21 app signed
ok 22 app flattened
# defaults-test:v0.34.0-mas-x64
ok 23 app signed
ok 24 app flattened
# defaults-test:v0.35.0-darwin-x64
ok 25 app signed
ok 26 app flattened
# defaults-test:v0.35.0-mas-x64
ok 27 app signed
ok 28 app flattened
# defaults-test:v0.36.0-darwin-x64
ok 29 app signed
ok 30 app flattened
# defaults-test:v0.36.0-mas-x64
ok 31 app signed
ok 32 app flattened
# teardown

1..32
# tests 32
# pass  32

# ok
```

## Collaborators

Thanks to [seanchas116](https://github.com/seanchas116), and [jasonhinkle](https://github.com/jasonhinkle) for improving the usability of this project implementation.

## Related

- [electron-packager] - package your electron app in OS executables (.app, .exe, etc) via JS or CLI

[npm_img]: https://img.shields.io/npm/v/electron-osx-sign.svg
[npm_url]: https://npmjs.org/package/electron-osx-sign
[travis_img]: https://travis-ci.org/electron-userland/electron-osx-sign.svg?branch=master
[travis_url]: https://travis-ci.org/electron-userland/electron-osx-sign
[electron-packager]: https://github.com/electron-userland/electron-packager
