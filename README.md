# electron-osx-sign

Code signing for Electron-packed OS X apps

## Installation

```sh
# for use in npm scripts
npm install electron-osx-sign --save-dev

# for use from cli
npm install electron-osx-sign -g
```

## Usage

### From the Command Line

```sh
electron-sign <app> [optional flags...]
```

For details on the optional flags, run `electron-sign --help` or see [usage.txt](https://github.com/sethlu/electron-sign/blob/master/usage.txt).

### Programmatic API

```javascript
var sign = require('electron-osx-sign')
sign(app[, opts[, function done (err) { }]])
```

#### sign(app, opts, callback)

##### app

Path to the application

##### opts

**Optional**

`entitlements` - *String*

Path to entitlements file for signing Mac App Store application.
See [mas.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.default.plist) for default.

`entitlements-inherit` - *String*

Path to child entitlements file for signing frameworks and bundles of Mac App Store application.
See [mas.inherit.default.plist](https://github.com/sethlu/electron-sign/blob/master/mas.inherit.default.plist) for default.

`helper-path` - *String*

Path to `Electron Helper.app`, which may be renamed.

`helper-eh-path` - *String*

Path to `Electron Helper EH.app`, which may be renamed.

`helper-np-path` - *String*

Path to `Electron Helper NP.app`, which may be renamed.

*Note: `helper-path`, `helper-eh-path`, `helper-np-path` needn't provided unless error thrown for not able to find any of them automatically.*

`identity` - *String*

Name of certificate to use when signing.
Default to retrieve from `login.keychain`.

`platform` - *String*

Build platform of Electron.
Allowed values: *darwin, mas*
Default: *darwin*

##### callback

`err` - *Error*

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

> electron-sign@0.1.0 test /Users/zhuolu/Development/electron-osx-sign
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

## Related

- [electron-packager](https://github.com/maxogden/electron-packager) - package your electron app in OS executables (.app, .exe, etc) via JS or CLI
