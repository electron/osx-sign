# electron-osx-sign [![npm][npm_img]][npm_url]

Code signing for Electron-packed OS X apps

## Installation

```sh
# For use in npm scripts
npm install electron-osx-sign --save-dev
```

```sh
# For use from cli
npm install electron-osx-sign -g
```

## Usage

### From the Command Line

```sh
electron-osx-sign <app> [optional flags...]
```

Example:

```sh
electron-osx-sign path/to/my.app
```

For details on the optional flags, run `electron-osx-sign --help` or see [usage.txt](https://github.com/sethlu/electron-sign/blob/master/usage.txt).

### From the API

```javascript
var sign = require('electron-osx-sign')
sign(opts[, function done (err) { }])
```

Example:

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

#### sign(opts, callback)

##### opts

**Required**

`app` - *String*

Path to the application package.

**Optional**

`entitlements` - *String*

Path to entitlements file for signing Mac App Store application.
See [mas.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.default.plist) for default.

`entitlements-inherit` - *String*

Path to child entitlements which inherit the security settings for signing frameworks and bundles of a distribution. *This option only applies when signing with `entitlements` provided, or for a `mas` platform version.*
See [mas.inherit.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.inherit.default.plist) for default.

`helper-path` - *String*

Path to `Electron Helper.app`, which may be renamed.
Default to detect from application package.

`helper-eh-path` - *String*

Path to `Electron Helper EH.app`, which may be renamed.
Default to detect from application package.

`helper-np-path` - *String*

Path to `Electron Helper NP.app`, which may be renamed.
Default to detect from application package.

*Note: `helper-path`, `helper-eh-path`, `helper-np-path` needn't provided unless error thrown for not able to find any of them automatically.*

`identity` - *String*

Name of certificate to use when signing.
Default to retrieve from `login.keychain`.

Signing platform `mas` will look for `3rd Party Mac Developer Application: * <*>`, and platform `darwin` will look for `Developer ID Application: * <*>` by default.

`platform` - *String*

Build platform of Electron.
Allowed values: `darwin`, `mas`.
Default to auto detect from presence of `Mantle.framework`, `ReactiveCocoa.framework`, and `Squirrel.framework` within the application package.

##### callback

`err` - *Error*

## Frequently Raised Issues

If error persists with `A timestamp was expected but was not found.` or `The timestamp service is not available.`, please try code sign the application later. The intermittent nature of the failures is a networking issue in communicating with the timestamp server.

## Electron

Note: The Mac App Store builds of Electron started from v0.34.0.

Note: From v0.36.0 there was a bug preventing GPU process to start after the app being sandboxed, so it is recommended to use v0.35.x before this bug gets fixed. You can find more about this in issue [atom/electron#3871](https://github.com/atom/electron/issues/3871), referred here at https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md.

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

> electron-sign@0.1.4 test electron-osx-sign
> standard && tape test

Calling electron-download before running tests...
Running tests...
TAP version 13
# setup
# defaults-test:v0.24.0-darwin-x64
ok 1 app signed
# defaults-test:v0.25.0-darwin-x64
ok 2 app signed
# defaults-test:v0.26.0-darwin-x64
ok 3 app signed
# defaults-test:v0.27.0-darwin-x64
ok 4 app signed
# defaults-test:v0.28.0-darwin-x64
ok 5 app signed
# defaults-test:v0.29.0-darwin-x64
ok 6 app signed
# defaults-test:v0.30.0-darwin-x64
ok 7 app signed
# defaults-test:v0.31.0-darwin-x64
ok 8 app signed
# defaults-test:v0.32.0-darwin-x64
ok 9 app signed
# defaults-test:v0.33.0-darwin-x64
ok 10 app signed
# defaults-test:v0.34.0-darwin-x64
ok 11 app signed
# defaults-test:v0.34.0-mas-x64
ok 12 app signed
# defaults-test:v0.35.0-darwin-x64
ok 13 app signed
# defaults-test:v0.35.0-mas-x64
ok 14 app signed
# defaults-test:v0.36.0-darwin-x64
ok 15 app signed
# defaults-test:v0.36.0-mas-x64
ok 16 app signed
# teardown

1..16
# tests 16
# pass  16

# ok
```

## Collaborators

Thanks to [seanchas116](https://github.com/seanchas116) for improving the usability of this project implementation.

## Related

- [electron-packager](https://github.com/maxogden/electron-packager) - package your electron app in OS executables (.app, .exe, etc) via JS or CLI

[npm_img]: https://img.shields.io/npm/v/electron-osx-sign.svg
[npm_url]: https://npmjs.org/package/electron-osx-sign
