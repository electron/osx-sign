# electron-sign

Codesign for Electron-packed apps

## Installation

```sh
# for use in npm scripts
npm install electron-sign --save-dev

# for use from cli
npm install electron-sign -g
```

## Usage

### From the Command Line

```sh
electron-sign <app> [optional flags...]
```

For details on the optional flags, run `electron-sign --help` or see [usage.txt](https://github.com/sethlu/electron-sign/blob/master/usage.txt).

### Programmatic API

```javascript
var sign = require('electron-sign')
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

## Related

- [electron-packager](https://github.com/maxogden/electron-packager) - package your electron app in OS executables (.app, .exe, etc) via JS or CLI
