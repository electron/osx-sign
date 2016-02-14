# electron-osx-sign [![npm][npm_img]][npm_url]

Code-signing for Electron-packed OS X apps.

The signing procedure follows what described in [Mac App Store Submission Guide](https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md).

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
electron-osx-sign <app> [additional-binaries...] [--options...]
```

Example:

```sh
electron-osx-sign path/to/my.app
```

For details on the optional flags, run `electron-osx-sign --help` or see [electron-osx-sign-usage.txt](https://github.com/sethlu/electron-sign/blob/master/bin/electron-osx-sign-usage.txt).

### From the API

```javascript
var sign = require('electron-osx-sign')
sign(opts[, function done (err) {}])
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

`binaries` - *Array*

Path to additional binaries that will be signed along with built-ins of Electron.
Default to `null`.

`entitlements` - *String*

Path to entitlements file for signing Mac App Store application.
See [mas.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.default.plist) for default.

`entitlements-inherit` - *String*

Path to child entitlements which inherit the security settings for signing frameworks and bundles of a distribution. *This option only applies when signing with `entitlements` provided, or for a `mas` platform version.*
See [mas.inherit.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.inherit.default.plist) for default.

`helper-path` - *String*

Path to `Electron Helper.app`, which may be renamed.
Default to detect from application package.

`helper-executable-path` - *String*

Path to `Electron Helper`, which may be renamed, in `Electron Helper.app`.
Default to detect from application package.

`helper-eh-path` - *String*

Path to `Electron Helper EH.app`, which may be renamed.
Default to detect from application package.

`helper-eh-executable-path` - *String*

Path to `Electron Helper EH`, which may be renamed, in `Electron Helper EH.app`.
Default to detect from application package.

`helper-np-path` - *String*

Path to `Electron Helper NP.app`, which may be renamed.
Default to detect from application package.

`helper-np-executable-path` - *String*

Path to `Electron Helper NP`, which may be renamed, in `Electron Helper NP.app`.
Default to detect from application package.

*Note: `helper-path`, `helper-eh-path`, `helper-np-path` needn't provided unless error thrown for not able to find any of them automatically.*

`identity` - *String*

Name of certificate to use when signing.
Default to retrieve from `login.keychain`.

Signing platform `mas` will look for `3rd Party Mac Developer Application: * <*>`, and platform `darwin` will look for `Developer ID Application: * <*>` by default.

`platform` - *String*

Build platform of Electron.
Allowed values: `darwin`, `mas`.
Default to auto detect from presence of `Squirrel.framework` within the application package.

`verbose` - *Boolean*

Verbose flag, to display every action through `console.log()`.
Allowed values: `true`, `false`.

##### callback

`err` - *Error*

## Frequently Raised Issues

If error persists with `A timestamp was expected but was not found.` or `The timestamp service is not available.`, please try code-sign the application later. The intermittent nature of the failures is a networking issue in communicating with the timestamp server.

## Notes

- Accidental halt of `codesign` may result in files with `.cstemp` extension created within the application. Please manually remove those files to avoid any issues that may occur during signing.

- As `productbuild` is not yet incorporated into this code-signing module, please refer to [#5](https://github.com/sethlu/electron-osx-sign/issues/5) for packing signed applications for iTunes Connect submission.

- In current version, binaries except built in within Electron will not be signed automatically. Please manually sign those before running this code-sign module. This issue may be resolved in future development, refer to [#6](https://github.com/sethlu/electron-osx-sign/issues/6).

- The Mac App Store builds of Electron started from v0.34.0.

- From v0.36.0 there was a bug preventing GPU process to start after the app being sandboxed, so it is recommended to use v0.35.x before this bug gets fixed. You can find more about this in issue [atom/electron#3871](https://github.com/atom/electron/issues/3871), refer to [Mac App Store Submission Guide](https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md).

- To verify Gatekeeper acceptance of signed application package, currently not included in the automation, for distribution outside the Mac App Store (`darwin` only), enter the following command in Terminal:
```
spctl --ignore-cache --no-cache -a -vvvv --type execute "path/to/my/app.app"
```
For more details, please refer to [Distributing Apps Outside the Mac App Store]( https://developer.apple.com/library/mac/documentation/IDEs/Conceptual/AppDistributionGuide/DistributingApplicationsOutside/DistributingApplicationsOutside.html).

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

> electron-sign@0.1.6 test electron-osx-sign
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

Thanks to [seanchas116](https://github.com/seanchas116), and [jasonhinkle](https://github.com/jasonhinkle) for improving the usability of this project implementation.

## Related

- [electron-packager](https://github.com/maxogden/electron-packager) - package your electron app in OS executables (.app, .exe, etc) via JS or CLI

[npm_img]: https://img.shields.io/npm/v/electron-osx-sign.svg
[npm_url]: https://npmjs.org/package/electron-osx-sign
