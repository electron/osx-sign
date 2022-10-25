# Migration from `electron-osx-sign` to `@electron/osx-sign`

We strongly recommend starting with the new defaults and migrating
to the new API surface carefully. Doing so will result in a more secure
and safe application.

## Direct migration

However, if you wish to emulate the exact behaviour from `electron-osx-sign`, you
can use the following setup to directly migrate your old preferences.
This pattern should result in identical behavior between the two modules.

```js
const oldOptions = {
  app: 'path/to/app',
  binaries: ['a', 'b'],
  entitlements: 'path/to/entitlements',
  'entitlements-inherit': 'path/to/inherited-entitlements', // Removed, use optionsForFile.entitlements
  'entitlements-loginhelper': 'path/to/login-entitlements', // Removed, use optionsForFile.entitlements
  entitlementsForFile: (filePath, codesignArgs) => 'path/to/different-entitlements',
  'gatekeeper-assess': true,
  hardenedRuntime: true,
  identity: 'My Identity',
  'identity-validation': false,
  keychain: 'Login.keychain',
  ignore: /bad-files/,
  platform: 'darwin',
  'pre-auto-entitlements': true,
  'pre-embed-provisioning-profile': true,
  'provisioning-profile': 'path/to/provisioning-profile',
  requirements: 'custom-requirements',
  restrict: true, // Removed, use optionsForFile.signatureFlags
  'signature-flags': 'foo,bar,thing',
  'signature-size': 12000, // Removed
  'strict-verify': true,
  timestamp: 'https://timestamp-server',
  type: 'distribution',
  version: '1.2.3',
}

const newOptions = {
  app: oldOptions.app,
  binaries: oldOptions.binaries,
  optionsForFile: (filePath) => ({
    // Ensure you return the right entitlements path here based on the file being signed.
    // E.g. The Login Helper should get oldOptions['entitlements-loginhelper']
    entitlements: getEntitlementsForFile(filePath),
    hardenedRuntime: oldOptions.hardenedRuntime,
    signatureFlags: oldOptions['signature-flags'],
    timestamp: oldOptions.timestamp,
  }),
  identity: oldOptions.identity,
  identityValidation: oldOptions['identity-validation'],
  keychain: oldOptions.keychain,
  ignore: oldOptions.ignore,
  platform: oldOptions.platform,
  preAutoEntitlements: oldOptions['pre-auto-entitlements'],
  preEmbedProvisioningProfile: oldOptions['pre-embed-provisioning-profile'],
  provisioningProfile: oldOptions['provisioning-profile'],
  strictVerify: oldOptions['strict-verify'],
  type: oldOptions.type,
  version: oldOptions.version,
}
```
